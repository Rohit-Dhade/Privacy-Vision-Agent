import { z } from "zod";

const actionSchema = z.object({
    action: z.enum(["click", "scroll", "fill", "wait", "done"]),
    targetSelector: z.string().nullable(),
    value: z.string().nullable(),
    reasoning: z.string(),
});

export default actionSchema;