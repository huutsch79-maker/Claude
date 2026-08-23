/**
 * Pluggable so the model-routing decision (spec: "per-capability config
 * field, not a runtime judgment call") extends to embeddings too. No
 * provider is wired by default — configure one via JARVIS_EMBEDDING_PROVIDER
 * before memory writes/searches will work. Kept out of core so swapping it
 * never touches domain-isolation code.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export class NotConfiguredEmbeddingProvider implements EmbeddingProvider {
  async embed(_text: string): Promise<number[]> {
    throw new Error(
      "No embedding provider configured. Set JARVIS_EMBEDDING_PROVIDER and wire it in " +
        "src/domain/embeddingProvider.ts before writing to or searching memory.",
    );
  }
}
