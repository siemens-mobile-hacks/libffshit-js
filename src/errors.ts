// What the library throws about a fullflash it cannot read, or an operation it cannot do. Anything
// else it throws is a bug.
export class FFSError extends Error {
    override name = "FFSError";
}
