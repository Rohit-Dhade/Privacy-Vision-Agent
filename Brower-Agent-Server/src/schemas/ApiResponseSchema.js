import { z } from "zod";

const messageSchema = z.object({
    role: z.string(),
    content: z.array(
        z.object({
            type: z.string(),
            text: z.string().optional(),

            source: z.object({
                type: z.string(),
                media_type: z.string(),
                data: z.string(),
            }).optional()
        })
    )
})

const actionSchema = z.create({
    model: z.string(),
    max_tokens: z.number(),
    system: z.string(),
    messages: z.array(messageSchema),
})

export default actionSchema;