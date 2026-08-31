import { Router } from "express";
import validateRequest from "../validation/validateRequest.js";
import handleAgentStep from "../controllers/agentControllers.js";
import { errorMiddleware } from "../middleware/errorhandler.js";

const agentRouter = Router();

agentRouter.post('/step', validateRequest, errorMiddleware, handleAgentStep);

export default agentRouter;