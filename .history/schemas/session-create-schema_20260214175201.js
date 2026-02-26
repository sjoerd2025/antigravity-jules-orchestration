import Joi from 'joi';

const sessionCreateSchema = Joi.object({
  prompt: Joi.string().trim().min(10).max(10000).required(),
  source: Joi.string().trim().pattern(/^sources\/github\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/).required(),
  branch: Joi.string().trim().max(100),
  title: Joi.string().trim().max(200),
  requirePlanApproval: Joi.boolean(),
  automationMode: Joi.string().valid('AUTO_CREATE_PR', 'NONE'),
});

export default sessionCreateSchema;
