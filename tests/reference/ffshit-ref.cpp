// Runs the C++ libffshit and prints what it did as JSON, for the tests to compare the rewrite
// with. Strings that may hold any bytes (names, paths, messages) are printed in hex.
//
//   ffshit-ref load <fullflash> [options]
//   ffshit-ref write <fullflash> <script> <saved fullflash> [options]
//
// Options: --platform=<type>, --old-search, --start=<address>, --skip-broken, --skip-dup,
// --parts=<name,name>, --codepage=<codepage>, --verbose-processing, --verbose-headers,
// --verbose-data, --no-tree
//
// A write script has an operation per line, strings in hex, timestamps in seconds:
//   codepage <codepage>
//   write <path> <size> <seed> <timestamp>
//   mkdir <path> <timestamp>
//   remove <path>
//   reload
//
//   ffshit-ref units < lines
//
// Runs the library's helpers on each line of input, printing a line of output for each:
//   fat2unix <FAT timestamp>             unix2fat <seconds>
//   hash16 <UTF-16LE name>               hash8 <8-bit name>
//   name2utf8 <codepage> <stored name>   utf82name <codepage> <UTF-8 name>
//   checkcp <codepage>                   utf16name <what follows a NewSGOLD header>

#include <ffshit/ex.h>
#include <ffshit/filesystem/ex.h>
#include <ffshit/filesystem/hash.h>
#include <ffshit/filesystem/help.h>
#include <ffshit/filesystem/platform/builder.h>
#include <ffshit/fullflash.h>
#include <ffshit/log/logger.h>
#include <ffshit/partition/ex.h>
#include <ffshit/patterns/ex.h>

#include "filesystem/codepage.h"

#include <iconv.h>

#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace FULLFLASH;

static std::string hex(const std::string &str) {
    static const char *digits = "0123456789abcdef";
    std::string result;

    for (unsigned char c : str) {
        result.push_back(digits[c >> 4]);
        result.push_back(digits[c & 0xF]);
    }

    return result;
}

static std::string unhex(const std::string &str) {
    std::string result;

    for (size_t i = 0; i + 1 < str.size(); i += 2) {
        result.push_back(static_cast<char>(std::stoi(str.substr(i, 2), nullptr, 16)));
    }

    return result;
}

static std::string json_string(const std::string &str) {
    return "\"" + str + "\"";
}

// FNV-1a
static uint32_t hash(const char *data, size_t size) {
    uint32_t h = 2166136261u;

    for (size_t i = 0; i < size; ++i) {
        h ^= static_cast<uint8_t>(data[i]);
        h *= 16777619u;
    }

    return h;
}

class Collector : public Log::Interface {
    public:
        std::vector<std::pair<char, std::string>> messages;

        void on_info(std::string msg) override      { messages.emplace_back('I', msg); }
        void on_warning(std::string msg) override   { messages.emplace_back('W', msg); }
        void on_error(std::string msg) override     { messages.emplace_back('E', msg); }
        void on_debug(std::string msg) override     { messages.emplace_back('D', msg); }
};

static std::shared_ptr<Collector> collector = std::make_shared<Collector>();

struct Options {
    std::string                 platform;
    bool                        old_search          = false;
    uint32_t                    start               = 0;
    bool                        skip_broken         = false;
    bool                        skip_dup            = false;
    std::vector<std::string>    parts;
    std::string                 codepage;
    bool                        verbose_processing  = false;
    bool                        verbose_headers     = false;
    bool                        verbose_data        = false;
    bool                        tree                = true;
};

static Options parse_options(int argc, char **argv, int first) {
    Options options;

    for (int i = first; i < argc; ++i) {
        std::string arg = argv[i];
        auto        value = [&](const std::string &name) { return arg.substr(name.size()); };

        if (arg.rfind("--platform=", 0) == 0) {
            options.platform = value("--platform=");
        } else if (arg == "--old-search") {
            options.old_search = true;
        } else if (arg.rfind("--start=", 0) == 0) {
            options.start = std::stoul(value("--start="), nullptr, 0);
        } else if (arg == "--skip-broken") {
            options.skip_broken = true;
        } else if (arg == "--skip-dup") {
            options.skip_dup = true;
        } else if (arg.rfind("--parts=", 0) == 0) {
            std::stringstream stream(value("--parts="));
            std::string       part;

            while (std::getline(stream, part, ',')) {
                options.parts.push_back(part);
            }
        } else if (arg.rfind("--codepage=", 0) == 0) {
            options.codepage = value("--codepage=");
        } else if (arg == "--verbose-processing") {
            options.verbose_processing = true;
        } else if (arg == "--verbose-headers") {
            options.verbose_headers = true;
        } else if (arg == "--verbose-data") {
            options.verbose_data = true;
        } else if (arg == "--no-tree") {
            options.tree = false;
        } else {
            throw std::invalid_argument("Unknown option " + arg);
        }
    }

    return options;
}

// The error as {"type": ..., "message": ...}
static std::string error_json(std::exception_ptr error) {
    std::string type;
    std::string message;

    try {
        std::rethrow_exception(error);
    } catch (const Partitions::Exception &e) {
        type = "PartitionsError";
        message = e.what();
    } catch (const Filesystem::Exception &e) {
        type = "FilesystemError";
        message = e.what();
    } catch (const Exception &e) {
        type = "FullflashError";
        message = e.what();
    } catch (const Patterns::Exception &e) {
        type = "PatternsError";
        message = e.what();
    } catch (const std::out_of_range &e) {
        type = "OutOfRangeError";
        message = e.what();
    } catch (const std::exception &e) {
        type = "Error";
        message = e.what();
    }

    return "{\"type\":" + json_string(type) + ",\"message\":" + json_string(hex(message)) + "}";
}

static int attributes(const Filesystem::Attributes &attributes) {
    return (attributes.is_readonly() ? 1 : 0) | (attributes.is_hidden() ? 2 : 0) | (attributes.is_system() ? 4 : 0) | (attributes.is_directory() ? 16 : 0);
}

static int64_t seconds(const Filesystem::TimePoint &time_point) {
    return std::chrono::duration_cast<std::chrono::seconds>(time_point.time_since_epoch()).count();
}

static void print_tree(std::ostream &out, const Filesystem::Directory::Ptr &dir) {
    out << "{\"n\":" << json_string(hex(dir->get_name())) << ",\"p\":" << json_string(hex(dir->get_path()))
        << ",\"a\":" << attributes(dir->get_attributes()) << ",\"t\":" << seconds(dir->get_timestamp()) << ",\"d\":[";

    bool first = true;

    for (const auto &subdir : dir->get_subdirs()) {
        out << (first ? "" : ",");
        print_tree(out, subdir);
        first = false;
    }

    out << "],\"f\":[";
    first = true;

    for (const auto &file : dir->get_files()) {
        const auto &data = file->get_data();

        out << (first ? "" : ",") << "{\"n\":" << json_string(hex(file->get_name())) << ",\"p\":" << json_string(hex(file->get_path()))
            << ",\"a\":" << attributes(file->get_attributes()) << ",\"t\":" << seconds(file->get_timestamp())
            << ",\"s\":" << file->get_size() << ",\"h\":" << hash(data.get_data().get(), data.get_size()) << "}";
        first = false;
    }

    out << "]}";
}

static void print_log(std::ostream &out) {
    out << "\"log\":[";

    for (size_t i = 0; i < collector->messages.size(); ++i) {
        out << (i ? "," : "") << "[\"" << collector->messages[i].first << "\"," << json_string(hex(collector->messages[i].second)) << "]";
    }

    out << "]";

    collector->messages.clear();
}

static void print_detector(std::ostream &out, const Platform::Detector &detector) {
    auto platform = detector.get_platform();

    out << "\"detector\":{\"platform\":" << json_string(platform == Platform::Type::UNK ? "UNK" : Platform::TypeToString.at(platform))
        << ",\"model\":" << json_string(hex(detector.get_model())) << ",\"imei\":" << json_string(hex(detector.get_imei()))
        << ",\"base\":" << json_string(std::to_string(detector.get_base_address())) << ",\"sl75\":" << (detector.is_sl75() ? "true" : "false") << "}";
}

static void print_partitions(std::ostream &out, const Partitions::Partitions &partitions) {
    auto platform = partitions.get_fs_platform();

    out << "\"partitions\":{\"fs_platform\":" << json_string(platform == Platform::Type::UNK ? "UNK" : Platform::TypeToString.at(platform)) << ",\"list\":[";

    bool first = true;

    for (const auto &pair : partitions.get_partitions()) {
        out << (first ? "" : ",") << "{\"name\":" << json_string(hex(pair.first)) << ",\"blocks\":[";

        bool first_block = true;

        for (const auto &block : pair.second.get_blocks()) {
            const auto &header = block.get_header();

            out << (first_block ? "" : ",") << "{\"addr\":" << block.get_addr() << ",\"size\":" << block.get_size()
                << ",\"name\":" << json_string(hex(std::string(header.name, 8))) << ",\"u1\":" << header.unknown_1
                << ",\"u2\":" << header.unknown_2 << ",\"u3\":" << header.unknown_3 << ",\"u4\":" << header.unknown_4 << "}";
            first_block = false;
        }

        out << "]}";
        first = false;
    }

    out << "]}";
}

static std::string pattern(size_t size, uint8_t seed) {
    std::string data(size, '\0');

    for (size_t i = 0; i < size; ++i) {
        data[i] = static_cast<char>((i * 31 + (i >> 8) + seed * 7) & 0xFF);
    }

    return data;
}

struct Loaded {
    FULLFLASH::FULLFLASH::Ptr fullflash;
    Filesystem::Base::Ptr   filesystem;
};

// Loads the fullflash as far as it goes, printing each stage
static Loaded load(std::ostream &out, const std::string &path, const Options &options) {
    Loaded      loaded;
    std::string stage = "fullflash";

    out << "{";

    try {
        // As the WebAssembly build does: from memory
        std::ifstream       file(path, std::ios_base::binary);
        std::vector<char>   data((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
        static char         none;
        char *              ptr = data.empty() ? &none : data.data();

        if (options.platform.empty()) {
            loaded.fullflash = FULLFLASH::FULLFLASH::build(ptr, data.size());
        } else {
            loaded.fullflash = FULLFLASH::FULLFLASH::build(ptr, data.size(), Platform::StringToType.at(options.platform));
        }

        print_detector(out, loaded.fullflash->get_detector());
        out << ",";

        stage = "partitions";

        loaded.fullflash->load_partitions(options.old_search, options.start);

        auto partitions = loaded.fullflash->get_partitions();

        print_partitions(out, *partitions);
        out << ",";

        stage = "filesystem";

        loaded.filesystem = Filesystem::build(partitions->get_fs_platform(), partitions);
        loaded.filesystem->log_verbose_processing(options.verbose_processing);
        loaded.filesystem->log_verbose_headers(options.verbose_headers);
        loaded.filesystem->log_verbose_data(options.verbose_data);

        if (!options.codepage.empty()) {
            loaded.filesystem->set_codepage(options.codepage);
        }

        loaded.filesystem->load(options.skip_broken, options.skip_dup, options.parts);

        stage = "done";

        if (options.tree) {
            out << "\"tree\":";
            print_tree(out, loaded.filesystem->get_root());
            out << ",";
        }
    } catch (...) {
        out << "\"error\":" << error_json(std::current_exception()) << ",";
        loaded.filesystem.reset();
    }

    out << "\"stage\":" << json_string(stage) << ",";
    print_log(out);
    out << "}";

    return loaded;
}

static int run_write(const std::string &path, const std::string &script_path, const std::string &saved_path, const Options &options) {
    std::ostream &out = std::cout;

    out << "{\"load\":";

    Loaded loaded = load(out, path, options);

    if (!loaded.filesystem) {
        out << "}\n";

        return 0;
    }

    out << ",\"results\":[";

    std::ifstream script(script_path);
    std::string   line;
    bool          first = true;

    while (std::getline(script, line)) {
        if (line.empty()) {
            continue;
        }

        std::stringstream   stream(line);
        std::string         op;

        stream >> op;

        out << (first ? "" : ",") << "{";
        first = false;

        try {
            if (op == "codepage") {
                std::string codepage;

                stream >> codepage;
                loaded.filesystem->set_codepage(codepage);
            } else if (op == "write") {
                std::string target;
                size_t      size;
                int         seed;
                int64_t     timestamp;

                stream >> target >> size >> seed >> timestamp;

                std::string data = pattern(size, seed);
                RawData     raw  = data.empty() ? RawData() : RawData(&data[0], data.size());

                loaded.filesystem->write_file(unhex(target), raw, std::chrono::system_clock::from_time_t(timestamp));
            } else if (op == "mkdir") {
                std::string target;
                int64_t     timestamp;

                stream >> target >> timestamp;
                loaded.filesystem->create_directory(unhex(target), std::chrono::system_clock::from_time_t(timestamp));
            } else if (op == "remove") {
                std::string target;

                stream >> target;
                loaded.filesystem->remove(unhex(target));
            } else if (op == "reload") {
                auto partitions = loaded.fullflash->get_partitions();

                loaded.filesystem = Filesystem::build(partitions->get_fs_platform(), partitions);

                if (!options.codepage.empty()) {
                    loaded.filesystem->set_codepage(options.codepage);
                }

                loaded.filesystem->load(options.skip_broken, options.skip_dup, options.parts);
            } else {
                throw std::invalid_argument("Unknown operation " + op);
            }

            out << "\"error\":null";
        } catch (...) {
            out << "\"error\":" << error_json(std::current_exception());
        }

        out << ",";
        print_log(out);
        out << "}";
    }

    out << "],\"tree\":";
    print_tree(out, loaded.filesystem->get_root());

    loaded.fullflash->save(saved_path);

    out << "}\n";

    return 0;
}


// The name after a NewSGOLD header, converted as SGOLD2::read_file_header() and
// SGOLD2_ELKA::read_file_header() convert it
static std::string utf16_name(const std::string &from_data) {
    size_t  str_size    = from_data.size();

    if (str_size == 0) {
        return "OK:";
    }

    std::vector<char> from(from_data.begin(), from_data.end());
    std::vector<char> to(str_size * 2);

    size_t  from_size   = str_size;
    size_t  to_size     = str_size;
    char *  inptr       = from.data();
    char *  ouptr       = to.data();
    iconv_t iccd        = iconv_open("UTF-8", "UTF-16LE");
    int     r           = iconv(iccd, &inptr, &from_size, &ouptr, &to_size);

    iconv_close(iccd);

    if (r == -1) {
        return "FAIL";
    }

    to[str_size - to_size] = 0x00;

    return "OK:" + hex(std::string(to.data()));
}

static std::string run_unit(const std::string &line) {
    std::stringstream   stream(line);
    std::string         op;

    stream >> op;

    try {
        if (op == "fat2unix") {
            uint32_t fat;

            stream >> fat;

            return std::to_string(std::chrono::duration_cast<std::chrono::seconds>(Filesystem::fat_timestamp_to_unix(fat).time_since_epoch()).count());
        }

        if (op == "unix2fat") {
            int64_t seconds;

            stream >> seconds;

            return std::to_string(Filesystem::unix_to_fat_timestamp(std::chrono::system_clock::from_time_t(seconds)));
        }

        if (op == "hash16" || op == "hash8") {
            std::string name;

            stream >> name;
            name = unhex(name);

            if (op == "hash8") {
                return std::to_string(Filesystem::name_hash_8bit(name));
            }

            std::u16string utf16(name.size() / 2, u'\0');

            memcpy(&utf16[0], name.data(), utf16.size() * 2);

            return std::to_string(Filesystem::name_hash_utf16(utf16));
        }

        if (op == "name2utf8" || op == "utf82name") {
            std::string codepage;
            std::string name;

            stream >> codepage >> name;
            name = unhex(name);

            return "OK:" + hex(op == "name2utf8" ? Filesystem::sgold_name_to_utf8(name, codepage) : Filesystem::sgold_name_from_utf8(name, codepage));
        }

        if (op == "checkcp") {
            std::string codepage;

            stream >> codepage;
            Filesystem::check_codepage(unhex(codepage));

            return "OK:";
        }

        if (op == "utf16name") {
            std::string name;

            stream >> name;

            return utf16_name(unhex(name));
        }
    } catch (const BaseException &e) {
        return "E:" + hex(e.what());
    }

    return "UNKNOWN";
}

int main(int argc, char **argv) {
    Log::Logger::init(collector);

    if (argc == 2 && std::string(argv[1]) == "units") {
        std::string line;

        while (std::getline(std::cin, line)) {
            std::cout << run_unit(line) << "\n";
        }

        return 0;
    }

    if (argc < 3) {
        std::cerr << "Usage: ffshit-ref load <fullflash> [options] | write <fullflash> <script> <saved> [options]\n";

        return 2;
    }

    std::string command = argv[1];

    if (command == "load") {
        load(std::cout, argv[2], parse_options(argc, argv, 3));
        std::cout << "\n";

        return 0;
    }

    if (command == "write" && argc >= 5) {
        return run_write(argv[2], argv[3], argv[4], parse_options(argc, argv, 5));
    }

    std::cerr << "Unknown command " << command << "\n";

    return 2;
}
