import { Router } from 'express';
import authRouter from './auth.routes.js';
import userRouter from './user.routes.js';
import matchRouter from './match.routes.js';
import chatRouter from './chat.routes.js';
import membershipRouter from './membership.routes.js';
import battleRouter from './battle.routes.js';
import dashboardRouter from './dashboard.routes.js';
import ticketRouter from './ticket.routes.js';

const rootRouter = Router();

rootRouter.use('/auth', authRouter);
rootRouter.use('/users', userRouter);
rootRouter.use('/matches', matchRouter);
rootRouter.use('/chat', chatRouter);
rootRouter.use('/membership', membershipRouter);
rootRouter.use('/battle', battleRouter);
rootRouter.use('/dashboard', dashboardRouter);
rootRouter.use('/admin/dashboard', dashboardRouter);
rootRouter.use('/tickets', ticketRouter);

export default rootRouter;
