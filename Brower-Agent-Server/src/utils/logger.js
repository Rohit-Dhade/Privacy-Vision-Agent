import winston from "winston";
import path from "path";

const logger = winston.createLogger({
    level: "http",

    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),

    transports: [
        new winston.transports.Console(),

        new winston.transports.File({
            filename: path.join(process.cwd(), "logs/combined.log"),
            console: false,
        }),

        new winston.transports.File({
            filename: path.join(process.cwd(), "logs/error.log"),
            level: "error",
            console: false,
        }),
    ],
});

export default logger;
