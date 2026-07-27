import { randomBytes } from 'node:crypto';

/** Ошибка, текст которой предназначен пользователю и показывается дословно. */
export class UserError extends Error {
  readonly kind = 'user' as const;
}

/** Сбой внешнего сервиса. Детали идут в лог, пользователю — имя провайдера. */
export class ProviderError extends Error {
  readonly kind = 'provider' as const;

  constructor(
    message: string,
    readonly provider: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Наша ошибка. Пользователю — только код инцидента, детали в лог. */
export class BugError extends Error {
  readonly kind = 'bug' as const;
}

export function newIncidentId(): string {
  return randomBytes(3).toString('hex');
}

export interface UserFacingError {
  text: string;
  /** Задан только когда ошибка наша: по нему находится стек в логах. */
  incidentId?: string;
}

export function describeForUser(error: unknown): UserFacingError {
  if (error instanceof UserError) {
    return { text: error.message };
  }
  if (error instanceof ProviderError) {
    return {
      text: `Сервис ${error.provider} сейчас недоступен. Попробуй позже — данные подтянутся сами.`,
    };
  }
  const incidentId = newIncidentId();
  return {
    text: `Что-то сломалось на нашей стороне. Код инцидента: \`${incidentId}\` — покажи его администратору.`,
    incidentId,
  };
}
