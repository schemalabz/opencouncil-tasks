import { Task } from "../tasks/pipeline";
import dotenv from 'dotenv';
import PyannoteDiarizer from "../lib/PyannoteDiarize";
import { Diarization } from "../types";

dotenv.config();

export const diarize: Task<string, Diarization> = async (audioUrl, onProgress) => {
    const diarizer = PyannoteDiarizer.getInstance();
    return diarizer.diarize([{ url: audioUrl, start: 0 }]);
};