import { ProviderCompatibleTypeEnum } from "../types";
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
    | { compatible_type?: ProviderCompatibleTypeEnum }
    | undefined;
    
  const ct = providerCfg?.compatible_type;
  if (ct === ProviderCompatibleTypeEnum.OpenAI || ct === ProviderCompatibleTypeEnum.Anthropic) {
    return `${ct}/${modelId}`;
  }
  return fullModel;
}
