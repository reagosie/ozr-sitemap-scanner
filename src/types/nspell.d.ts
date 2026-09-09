/**
 * nspell ships no types. Only the surface this project uses is declared.
 *
 * The constructor is callable with or without `new`, and accepts either two
 * buffers or the `{aff, dic}` object that `dictionary-en` exports.
 */
declare module 'nspell' {
  interface NSpell {
    /** True when the word is in the dictionary. */
    correct(word: string): boolean;
    suggest(word: string): string[];
    /** Add a word to this instance's dictionary. */
    add(word: string, model?: string): NSpell;
    remove(word: string): NSpell;
  }

  interface Dictionary {
    aff: Uint8Array | Buffer | string;
    dic: Uint8Array | Buffer | string;
  }

  function nspell(dictionary: Dictionary): NSpell;
  function nspell(aff: Uint8Array | Buffer | string, dic: Uint8Array | Buffer | string): NSpell;

  export = nspell;
}

declare module 'dictionary-en' {
  const dictionary: { aff: Uint8Array; dic: Uint8Array };
  export default dictionary;
}
