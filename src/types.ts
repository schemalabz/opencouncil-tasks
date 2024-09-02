
export type Stage =
    "downloading-video" |
    "segmenting-video" |
    "transcribing" |
    "uploading-audio" |
    "finished";

export interface TranscribeRequest {
    youtubeUrl: string;
    callbackUrl: string;
    customVocabulary?: string[];
    customPrompt?: string;
}

export interface TranscribeResponse {
    videoUrl: string;
    transcript: Transcript;
}

export interface TranscribeUpdate {
    status: "processing" | "success" | "error";
    stage: Stage;
    progressPercent: number;
    response?: TranscribeResponse;
}

export interface Transcript {
    metadata: {
        audio_duration: number;
        number_of_distinct_channels: number;
        billing_time: number;
        transcription_time: number;
    };
    transcription: {
        languages: string[];
        full_transcript: string;
        utterances: Utterance[];
    };
}

interface Utterance {
    text: string;
    language: string;
    start: number;
    end: number;
    confidence: number;
    channel: number;
    speaker: number;
    words: Word[];
}

interface Word {
    word: string;
    start: number;
    end: number;
    confidence: number;
}
