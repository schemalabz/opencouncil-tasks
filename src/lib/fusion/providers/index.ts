import type { CityLanguage } from "../../../types.js";
import type { FusionConfig } from "../config.js";
import type { AsrProvider, ProviderId } from "../types.js";
import { ScribeProvider } from "./scribe.js";
import { SonioxProvider } from "./soniox.js";
import { OcAsrProvider } from "./ocasr.js";
import { ReplayProvider } from "./replay.js";

export type ProviderSet = Record<ProviderId, AsrProvider>;

/**
 * One place decides live vs replay. Anything else — a per-provider switch, a
 * "use replay if the key is missing" fallback — eventually produces a run where
 * two of the three systems are real and nobody notices which.
 */
export function createProviders(config: FusionConfig, language: CityLanguage | undefined): ProviderSet {
    if (config.replayDir) {
        const replayDir = config.replayDir;
        return {
            scribe: new ReplayProvider("scribe", replayDir),
            soniox: new ReplayProvider("soniox", replayDir),
            ours: new ReplayProvider("ours", replayDir),
        };
    }
    return {
        scribe: new ScribeProvider(language),
        soniox: new SonioxProvider(),
        ours: new OcAsrProvider(),
    };
}

export { ScribeProvider, SonioxProvider, OcAsrProvider, ReplayProvider };
