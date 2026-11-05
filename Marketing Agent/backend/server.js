require('dotenv').config();
const mongoose = require('mongoose');

const { PORT = 3000, MONGODB_URI = 'mongodb://127.0.0.1:27017/marketing_agent', JWT_SECRET } = process.env;
if (!JWT_SECRET || JWT_SECRET === 'change-me') {
  console.error('Set a real JWT_SECRET in backend/.env (copy .env.example to .env).');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    require('./app').listen(PORT, () => console.log(`Marketing Agent running at http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Could not connect to MongoDB. Is the MongoDB service running?\n', err.message);
    process.exit(1);
  });
