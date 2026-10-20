import { initializeApp, getApps } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: "AIzaSyCyp6V7w0G-zWfLsb6E_F4OL2aeekC8Qgw",
  authDomain: "poker-home-game-699e7.firebaseapp.com",
  databaseURL: "https://poker-home-game-699e7-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "poker-home-game-699e7",
  storageBucket: "poker-home-game-699e7.appspot.com",
  messagingSenderId: "582822571483",
  appId: "1:582822571483:web:3a7e7e74e6fded762fd45f"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const database = getDatabase(app);

export { app, database };

