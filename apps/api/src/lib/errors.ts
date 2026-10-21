export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'erro') { super(message); }
}
export const badRequest = (m: string, code = 'dados_invalidos') => new HttpError(400, m, code);
export const unauthorized = (m = 'Não autenticado') => new HttpError(401, m, 'nao_autenticado');
export const forbidden = (m = 'Sem permissão') => new HttpError(403, m, 'sem_permissao');
export const notFound = (m = 'Não encontrado') => new HttpError(404, m, 'nao_encontrado');
export const conflict = (m: string, code = 'conflito') => new HttpError(409, m, code);
export const tooMany = (m: string) => new HttpError(429, m, 'muitas_tentativas');
