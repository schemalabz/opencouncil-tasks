import { Task } from "../tasks/pipeline.js";
import dotenv from 'dotenv';
import PyannoteDiarizer from "../lib/PyannoteDiarize.js";
import { Diarization } from "../types.js";

dotenv.config();

export const diarize: Task<string, Diarization> = async (audioUrl, onProgress) => {
    const diarizer = PyannoteDiarizer.getInstance();
    return diarizer.diarize([{ url: audioUrl, start: 0 }]);
};