// Typen der Instanz-Einstellungen (io-package.json -> native) fuer die
// Typpruefung der JS-Dateien (tsconfig.json, checkJs).
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            username: string;
            password: string;
            machId: string;
            writeAccess: 'off' | 'operation' | 'setup';
            extraWritable: string;
            neverWritable: string;
            /** Names used by the 2.0.0 betas, read as fallback only. */
            schreiben?: string;
            eigeneFreigaben?: string;
            eigeneSperren?: string;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
