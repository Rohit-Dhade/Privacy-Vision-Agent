import express from "express";
import cors from "cors";
import morgan from "morgan";
import requestLogger from "./middleware/requestLogger.js";
import agentRouter from "./routes/agentRoutes.js";
import { errorMiddleware } from "./middleware/errorhandler.js";

const app = express();

// Allow the Chrome extension popup (chrome-extension://*) and localhost
// dev tools to call the API without CORS rejections.
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (curl / Postman) and any
        // chrome-extension:// or localhost origin.
        if (!origin ||
            origin.startsWith('chrome-extension://') ||
            /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
            return callback(null, true);
        }
        callback(new Error(`CORS: Origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(morgan("dev"));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger)

app.get("/", (req, res) => {
    res.status(200).json({ "message": "Privacy Vision Agent Server is running" });
});

app.use('/api/agent', agentRouter);

app.use(errorMiddleware)


export default app;