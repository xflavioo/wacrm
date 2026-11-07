import { describe, expect, it } from 'vitest';

import {
  matchNumberedReply,
  optionsFromPayload,
  renderNumberedText,
} from './interactive-text';

const options = [
  { id: 'reservar', title: 'Reservar festa' },
  { id: 'cardapio', title: 'Ver cardápio' },
  { id: 'humano', title: 'Falar com atendente' },
];

describe('renderNumberedText', () => {
  it('renders header, body, numbered options, the instruction and footer', () => {
    const t = renderNumberedText({
      headerText: 'Niverlândia',
      bodyText: 'Como podemos ajudar?',
      footerText: 'Atendimento 9h às 18h',
      options,
    });
    expect(t).toBe(
      [
        '*Niverlândia*',
        'Como podemos ajudar?',
        '1) Reservar festa\n2) Ver cardápio\n3) Falar com atendente',
        'Responda com o número da opção (1 a 3).',
        '_Atendimento 9h às 18h_',
      ].join('\n\n')
    );
  });

  it('uses the singular instruction for one option', () => {
    expect(renderNumberedText({ bodyText: 'Ok?', options: [options[0]] })).toContain(
      'Responda com o número da opção (1).'
    );
  });
});

describe('matchNumberedReply', () => {
  it.each(['2', ' 2 ', '2)', 'opção 2', 'opcao 2', 'Opção 2.'])('"%s" → option 2', (text) => {
    expect(matchNumberedReply(options, text)?.id).toBe('cardapio');
  });

  it('matches the option title ignoring case and accents', () => {
    expect(matchNumberedReply(options, 'ver CARDAPIO')?.id).toBe('cardapio');
  });

  it('does not treat an out-of-range number or ordinary text as a tap', () => {
    expect(matchNumberedReply(options, '0')).toBeNull();
    expect(matchNumberedReply(options, '4')).toBeNull();
    expect(matchNumberedReply(options, 'quero saber o preço')).toBeNull();
    expect(matchNumberedReply(options, '')).toBeNull();
    expect(matchNumberedReply(options, '12345')).toBeNull();
  });
});

describe('optionsFromPayload', () => {
  it('flattens list sections in display order', () => {
    expect(
      optionsFromPayload({
        kind: 'list',
        body: 'b',
        button_label: 'Ver',
        sections: [
          { rows: [{ id: 'a', title: 'A' }] },
          { rows: [{ id: 'b', title: 'B' }, { id: 'c', title: 'C' }] },
        ],
      })
    ).toEqual([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]);
  });
});
