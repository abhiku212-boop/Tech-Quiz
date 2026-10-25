import mongoose from 'mongoose';
import { config } from './config.js';

let connecting = null;

export async function connectDb() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connecting) return connecting;

  mongoose.set('strictQuery', true);
  connecting = mongoose
    .connect(config.mongoUri, { serverSelectionTimeoutMS: 15000 })
    .then((m) => {
      console.log(`[db] connected to "${m.connection.name}"`);
      return m.connection;
    })
    .finally(() => {
      connecting = null;
    });

  return connecting;
}

export async function disconnectDb() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}
