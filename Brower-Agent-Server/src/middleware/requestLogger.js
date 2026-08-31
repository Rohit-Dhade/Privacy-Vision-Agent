import logger from "../utils/logger.js";

const requestLogger = (req, res, next) => {
    const start = Date.now();

    res.on("finish", () => {
        const duration = Date.now() - start;

        logger.http(`${req.method} ${req.originalUrl}`, {
            statusCode: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip,
        });
    });

    next();
};

export default requestLogger;