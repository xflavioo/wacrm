// Tradução de erros do Evolution para respostas HTTP das rotas de
// gerenciamento. Fora dos arquivos `route.ts` porque o Next só aceita
// handlers e configuração como exports de rota.

import { NextResponse } from 'next/server';

import { EvolutionError } from './client';
import { EvolutionConfigError } from './config';

/** Erro do cliente Evolution → resposta HTTP com a mensagem em pt-BR. */
export function evolutionErrorResponse(err: unknown): NextResponse {
  if (err instanceof EvolutionError) {
    // 502 quando o servidor Evolution está inalcançável; 400 quando o
    // problema é o que o usuário informou (chave, instância, URL).
    const status = err.code === 'timeout' || err.code === 'network' ? 502 : 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  if (err instanceof EvolutionConfigError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
  console.error(
    '[evolution] unexpected error:',
    err instanceof Error ? err.message : err
  );
  return NextResponse.json(
    { error: 'Erro inesperado ao falar com o Evolution.' },
    { status: 500 }
  );
}
