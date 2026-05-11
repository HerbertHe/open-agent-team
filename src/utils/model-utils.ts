import type { TeamFileProvidersConfig } from "../types";

export function rewriteModelProviderByCompatibleType(
  fullModel: string,
  providers?: TeamFileProvidersConfig
): string {
  const idx = fullModel.indexOf("/");
  if (idx <= 0) return fullModel;
  const providerKey = fullModel.slice(0, idx);
  const modelId = fullModel.slice(idx + 1);
  if (!modelId) return fullModel;
  
  const providerCfg = providers?.[providerKey] as
    | { compatible_type?: "openai" | "anthropic" }
    | undefined;
    
  const ct = providerCfg?.compatible_type;
  if (ct === "openai" || ct === "anthropic") {
    return `${ct}/${modelId}`;
  }
  return fullModel;
}
