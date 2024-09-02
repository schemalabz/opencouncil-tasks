import { Task } from "../tasks/pipeline";
import dotenv from 'dotenv';
import { pyannoteDiarizer } from "../lib/PyannoteDiarize";
import { Diarization } from "../types";

dotenv.config();

export const diarize: Task<string, Diarization> = async (audioUrl, onProgress) => {
    return pyannoteDiarizer.diarize([{ url: audioUrl, start: 0 }]);
};