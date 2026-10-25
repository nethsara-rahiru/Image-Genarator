import { configuration } from './src/config/index.js';
import express from 'express';
import helmet from 'helmet';
import { errorHandler } from './src/utils/errors.js';
const config=configuration();
const app=express();app.use(helmet());app.get('/api/health',(req,res)=>res.json({status:'starting'}));app.use(errorHandler);
app.listen(config.PORT,config.HOST);
