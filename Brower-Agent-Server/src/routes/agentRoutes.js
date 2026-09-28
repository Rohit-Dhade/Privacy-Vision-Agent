import { Router } from "express";
import validateRequest from "../validation/validateRequest.js";
import handleAgentStep from "../controllers/agentControllers.js";

const agentRouter = Router();

agentRouter.post('/step', validateRequest, handleAgentStep);

export default agentRouter;