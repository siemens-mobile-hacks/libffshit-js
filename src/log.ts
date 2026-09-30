export interface LogInterface {
    onInfo(msg: string): void;
    onWarning(msg: string): void;
    onError(msg: string): void;
    onDebug(msg: string): void;
}

let logInterface: LogInterface | undefined;

// Where the messages of every loader and writer go. Without an interface they are dropped.
export const Logger = {
    init(newInterface: LogInterface | undefined): void {
        logInterface = newInterface;
    },

    getInterface(): LogInterface | undefined {
        return logInterface;
    },

    info(msg: string): void {
        logInterface?.onInfo(msg);
    },

    warn(msg: string): void {
        logInterface?.onWarning(msg);
    },

    error(msg: string): void {
        logInterface?.onError(msg);
    },

    debug(msg: string): void {
        logInterface?.onDebug(msg);
    },
};
