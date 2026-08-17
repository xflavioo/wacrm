// ============================================================
// O loop de retry por variante de endereço, extraído dos quatro
// lugares onde estava copiado (send-message.ts, flows/meta-send.ts ×2,
// automations/meta-send.ts).
//
// A política é do PROVEDOR: quais endereços tentar e o que conta como
// "tente o próximo". Este helper só executa. Assim a Evolution entra
// devolvendo uma variante só e nunca herda as tentativas de trunk-0
// que existem por causa do sandbox da Meta.
// ============================================================

import type { WhatsAppProvider } from './types';

export interface AddressRetryResult {
  messageId: string;
  /**
   * O endereço que efetivamente funcionou. Quando difere do que entrou,
   * o chamador grava de volta em `contacts.phone` — comportamento
   * preservado do código original.
   */
  workingAddress: string;
}

export async function sendWithAddressRetry(
  provider: WhatsAppProvider,
  address: string,
  attempt: (address: string) => Promise<string>
): Promise<AddressRetryResult> {
  // Um provedor que não conhece variantes ainda precisa de uma tentativa.
  const variants = provider.addressVariants(address);
  const candidates = variants.length > 0 ? variants : [address];

  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const messageId = await attempt(candidate);
      return { messageId, workingAddress: candidate };
    } catch (err) {
      // Não-retryable sobe na hora: repetir "token inválido" em três
      // variantes é só três chamadas perdidas. O erro vai CRU para o
      // provedor — cada um stringifica (ou não) do jeito que precisar.
      if (!provider.isRetryableAddressError(err)) throw err;
      lastError = err;
      console.warn(
        `[provider:${provider.kind}] address "${candidate}" rejected, trying next…`
      );
    }
  }

  throw lastError;
}
