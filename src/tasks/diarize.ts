import { Task } from "../tasks/pipeline.js";
import dotenv from 'dotenv';
import PyannoteDiarizer from "../lib/PyannoteDiarize.js";
import { DiarizeRequest, DiarizeResult } from "../types.js";

dotenv.config();

export const diarize: Task<Omit<DiarizeRequest, "callbackUrl">, DiarizeResult> = async ({ audioUrl, voiceprints }, onProgress) => {
    const diarizer = PyannoteDiarizer.getInstance();
    return diarizer.diarize([{ url: audioUrl, start: 0 }], voiceprints);
};