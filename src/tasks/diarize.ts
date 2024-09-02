import { Task } from "../tasks/pipeline";
import { callbackServer } from "../lib/CallbackServer";
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { Diarization, pyannoteDiarizer } from "../lib/PyannoteDiarize";

dotenv.config();

export const diarize: Task<{ url: string, start: number }[], Diarization> = async (segments, onProgress) => {
    return pyannoteDiarizer.diarize(segments);
};