export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.name === "MulterError") {
    return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error: {
        code: err.code,
        message: "Upload limits exceeded (5 files, 10 MB each)",
      },
    });
  }
  const validation = err.name === "ZodError" || err.name === "CastError";
  res.status(err.status || (validation ? 400 : 500)).json({
    error: {
      code: err.code || (validation ? "VALIDATION" : "INTERNAL"),
      message: err.status
        ? err.message
        : validation
          ? "Invalid request"
          : "Internal server error",
    },
  });
}
