import logger from "../utils/logger.js";

export const errorMiddleware = (err, req, res, next) => {
    err.statusCode = err.statusCode || err.status || 500;
    err.message = err.message || "Internal Server Error";

    logger.error(`${req.method} ${req.originalUrl} -> ${err.statusCode}: ${err.message}`, {
        stack: err.stack,
    });

    res.status(err.statusCode).json({
        success: false,
        message: err.statusCode < 500 ? err.message : "Internal Server Error",
    });
};