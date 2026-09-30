import { SGOLD_OBEX, type Phone } from "./phone.js";

export const CX70: Phone = {
    device:         "siemens-cx70",
    fullflash:      "CX70v56lg3.bin",
    deviceName:     "SIEMENS CX70 v56",
    platform:       "SGOLD",
    partition:      "FFS",
    chunkSize:      1024,
    firmwareFile:   "Pictures/Wallpaper/Beehive.jpg",
    readyScreen:    "CX70.png",
    unreliableObex: SGOLD_OBEX,
};

export const SL65: Phone = {
    device:         "siemens-sl65",
    fullflash:      "SL65v49lg1_TIM.bin",
    deviceName:     "SIEMENS SL65 v49",
    platform:       "SGOLD",
    partition:      "FFS",
    chunkSize:      1024,
    firmwareFile:   "Pictures/schiena.jpg",
    readyScreen:    "SL65.png",
    unreliableObex: SGOLD_OBEX,
};

export const S75: Phone = {
    device:         "siemens-s75",
    fullflash:      "S75v40lg1.bin",
    deviceName:     "SIEMENS S75 v40",
    platform:       "NewSGOLD",
    partition:      "FFS_0",
    chunkSize:      2048,
    firmwareFile:   "Sounds/Caribic.mid",
    readyScreen:    "S75.png",
    utcOffset:      240,
};

export const EL71: Phone = {
    device:         "siemens-el71",
    fullflash:      "EL71v41lg91.bin",
    deviceName:     "SIEMENS EL71 v41",
    platform:       "NewSGOLD",
    partition:      "FFS_0",
    chunkSize:      2048,
    firmwareFile:   "Pictures/Frames/frame15.png",
    readyScreen:    "EL71.png",
    utcOffset:      60,
};
