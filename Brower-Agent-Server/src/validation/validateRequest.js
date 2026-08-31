import requestSchema from "../schemas/requestSchema.js";

const validateRequest = (req, res, next) => {
    const result = requestSchema.safeParse(req.body);

    if (!result.success) {
        return res.status(400).json({
            success: false,
            message: "Invalid request body",
            errors: result.error.issues
        })
    }

    req.body = result.data;

    console.log("Checking from validateRequest->", req.body)
    next();
}

export default validateRequest;