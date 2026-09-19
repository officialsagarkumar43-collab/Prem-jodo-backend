import { ApiError } from '../utils/ApiError.js';

/**
 * Middleware factory to validate request data against a Zod schema
 */
export const validate = (schema) => (req, res, next) => {
  try {
    schema.parse({
      body: req.body,
      query: req.query,
      params: req.params
    });
    next();
  } catch (error) {
    const errorMessages = error.errors?.map((err) => ({
      field: err.path.join('.'),
      message: err.message
    })) || [];
    
    return next(new ApiError(400, 'Validation Error', errorMessages));
  }
};
