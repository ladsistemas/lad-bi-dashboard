/* ==========================================================================
 * LAD BI - Painel estatico (S3)
 * Configuracao central. Edite aqui para apontar para outro ambiente.
 * ========================================================================== */
window.LADBI = window.LADBI || {};

LADBI.config = {
  // URL base da API. Producao: https://biapi.ladsistemas.com.br
  // Pode ser sobrescrita definindo window.LADBI_API_BASE antes deste script
  // (util para apontar para homologacao sem reeditar o arquivo).
  apiBase: (window.LADBI_API_BASE || 'https://biapi.ladsistemas.com.br').replace(/\/+$/, ''),

  // Empresa pre-selecionada ao entrar (null = primeira da lista do usuario).
  empresaPadrao: 924,

  // Identidade visual
  brand: 'LAD BI',
  subtitle: 'Painel de Indicadores',

  // Chave de armazenamento da sessao no navegador
  storageKey: 'ladbi.session.v1',
  prefsKey: 'ladbi.prefs.v1'
};
