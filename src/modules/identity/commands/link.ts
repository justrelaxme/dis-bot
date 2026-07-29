import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { describeForUser, UserError } from '../../../core/errors.js';
import type { EventBus } from '../../../core/events/bus.js';
import type { CommandDefinition } from '../../../core/module.js';
import { canVerify, type GameProvider } from '../providers/provider.js';
import { RIOT_PLATFORMS, parseRiotId, platformToRegionalRoute } from '../providers/riot.js';
import { manualValorantRank } from '../providers/valorant.js';
import type { ProviderId } from '../schema.js';
import type { LinkingService } from '../services/linking.js';
import type { RankSyncService } from '../services/rank-sync.js';
import type { RoleMappingService } from '../services/role-mapping.js';

/**
 * Общие зависимости всех команд модуля identity. Объявляется здесь (Task 14) и
 * используется без изменений командами /unlink, /profile и /rolemap — менять
 * форму этого типа значит менять контракт сразу нескольких задач.
 */
export interface IdentityDeps {
  linking: LinkingService;
  providers: Map<ProviderId, GameProvider>;
  roles: RoleMappingService;
  rankSync: RankSyncService;
  bus: EventBus;
}

function requireProvider(deps: IdentityDeps, id: ProviderId): GameProvider {
  const provider = deps.providers.get(id);
  if (!provider) {
    throw new UserError(`Интеграция «${id}» на этом сервере не подключена.`);
  }
  return provider;
}

/**
 * canVerify — обычный boolean, а не type predicate: он не умеет сужать
 * необязательные startVerification/completeVerification у переданного provider.
 * Методы забираются в локальные переменные и проверяются самостоятельно —
 * тогда TypeScript сужает их без непроверяемого `!`.
 */
function requireVerificationMethods(provider: GameProvider): {
  startVerification: NonNullable<GameProvider['startVerification']>;
  completeVerification: NonNullable<GameProvider['completeVerification']>;
} {
  const { startVerification, completeVerification } = provider;
  if (!canVerify(provider) || !startVerification || !completeVerification) {
    throw new UserError(`Провайдер «${provider.id}» не умеет подтверждать владение аккаунтом.`);
  }
  return { startVerification, completeVerification };
}

export function createLinkCommand(deps: IdentityDeps): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('link')
      .setDescription('Привязать игровой аккаунт')
      .addSubcommand((sub) => sub.setName('steam').setDescription('Привязать Steam через вход на сайте Steam'))
      .addSubcommand((sub) =>
        sub
          .setName('riot')
          .setDescription('Привязать аккаунт League of Legends или TFT')
          .addStringOption((option) =>
            option.setName('riot-id').setDescription('Riot ID в виде Имя#Тег').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('platform')
              .setDescription('Платформа, например euw1 или ru')
              .setRequired(true)
              .addChoices(...RIOT_PLATFORMS.slice(0, 25).map((p) => ({ name: p, value: p }))),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('valorant')
          .setDescription('Указать аккаунт и ранг Valorant вручную')
          .addStringOption((option) =>
            option.setName('riot-id').setDescription('Riot ID в виде Имя#Тег').setRequired(true),
          )
          .addStringOption((option) =>
            option.setName('rank').setDescription('Например: Immortal 2 или Radiant').setRequired(true),
          ),
      ),

    async execute(interaction, ctx) {
      const userId = interaction.user.id;
      await deps.linking.ensureUser(userId);

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'steam') {
        const provider = requireProvider(deps, 'steam');
        const { startVerification } = requireVerificationMethods(provider);

        const challenge = await startVerification(userId);
        await deps.linking.openChallenge(userId, 'steam', challenge);
        await interaction.followUp({
          content: challenge.instruction ?? 'Ссылка не сформирована.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'valorant') {
        const riotId = interaction.options.getString('riot-id', true);
        const rankInput = interaction.options.getString('rank', true);

        const provider = requireProvider(deps, 'riot-valorant');
        const profile = await provider.fetchProfile(riotId);
        // Ранг разбирается до записи: незачем создавать привязку с мусорным рангом.
        const rank = manualValorantRank(rankInput);

        const accountId = await deps.linking.linkAccount(
          userId,
          'riot-valorant',
          { externalId: profile.externalId, displayName: profile.displayName, verificationMethod: 'manual' },
          // Подтверждения владения у Valorant нет и не будет (см. providers/valorant.ts) —
          // это не техническое ограничение сегодняшнего дня, а осознанное «false» навсегда.
          false,
        );
        await deps.linking.saveRank(accountId, rank);
        await deps.bus.emit('account.linked', {
          userId,
          provider: 'riot-valorant',
          externalId: profile.externalId,
          verified: false,
        });

        await interaction.followUp({
          content:
            `Valorant записан: **${profile.displayName}**, ранг ${rank.tier}${rank.division ? ` ${rank.division}` : ''}.\n` +
            `Подтвердить владение аккаунтом Valorant нечем, поэтому ранг помечен как заявленный тобой и авто-роль не даёт. ` +
            `При смене сезона обнови его этой же командой.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // subcommand === 'riot'
      const riotId = interaction.options.getString('riot-id', true);
      const platform = interaction.options.getString('platform', true);
      // Платформа проверяется до сети: неизвестный регион не должен стоить запроса.
      platformToRegionalRoute(platform);

      if (!parseRiotId(riotId)) {
        throw new UserError('Riot ID пишется как Имя#Тег, например Игрок#EUW.');
      }

      const provider = requireProvider(deps, 'riot-lol');
      const { startVerification, completeVerification } = requireVerificationMethods(provider);
      const pending = await deps.linking.pendingChallenge(userId, 'riot-lol');

      if (!pending) {
        const challenge = await startVerification(userId);
        await deps.linking.openChallenge(userId, 'riot-lol', { ...challenge, payload: { platform } });
        await interaction.followUp({
          content: challenge.instruction ?? 'Код не сформирован.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // takeChallenge помечает испытание использованным (инкремент попыток, выброс по
      // истечении/лимиту) — это одноразовость подтверждения, и её сайд-эффект нужен
      // даже если сам возврат не используется.
      //
      // Платформа в payload при этом обновляется на ту, что указана в ТЕКУЩЕМ вызове,
      // а не оставляется из pending.payload (записанного на первом вызове). Игрок мог
      // ошибиться в платформе, когда запрашивал код, и указать верную только на этом,
      // подтверждающем шаге — именно она проверяется выше (platformToRegionalRoute) и
      // именно она обязана дойти до completeVerification. Если бы использовалась
      // сохранённая платформа, аргумент этого вызова проверялся бы и тут же
      // отбрасывался: запрос ушёл бы на регион первого (возможно, ошибочного) вызова,
      // третий-парти-код почти наверняка не нашёлся бы там (404 → ProviderError →
      // «сервис недоступен» пользователю, хотя он всё указал верно), и он терял бы
      // одну из пяти попыток на нашу же ошибку.
      await deps.linking.takeChallenge(pending.challenge);
      const verified = await completeVerification(
        { challenge: pending.challenge, expiresAt: new Date(Date.now() + 60_000), payload: { ...pending.payload, platform } },
        riotId,
      );

      // PUUID и подтверждение владения общие для LoL и TFT, поэтому привязываются оба:
      // иначе маппинги ролей для tft-ranked никогда бы не срабатывали. Обе записи не в
      // транзакции (linkAccount — два независимых похода в БД), поэтому вторая
      // итерация может упасть уже после того, как первая сохранена и её account.linked
      // опубликован (например, riot-tft той же PUUID оказался приватизирован другим
      // пользователем, который в своё время отвязал только половину пары). Ошибку
      // первой итерации незачем ловить отдельно: пока linkedProviders пуст, это
      // обычный сбой без частичного состояния, и он должен уйти наверх как раньше.
      const linkedProviders: Array<'riot-lol' | 'riot-tft'> = [];
      const linkedIds: number[] = [];
      let partialFailure: { provider: 'riot-lol' | 'riot-tft'; error: unknown } | null = null;

      for (const providerId of ['riot-lol', 'riot-tft'] as const) {
        try {
          linkedIds.push(await deps.linking.linkAccount(userId, providerId, verified, true));
          linkedProviders.push(providerId);
          await deps.bus.emit('account.linked', {
            userId,
            provider: providerId,
            externalId: verified.externalId,
            verified: true,
          });
        } catch (error) {
          if (linkedProviders.length === 0) throw error;
          partialFailure = { provider: providerId, error };
          break;
        }
      }

      // Синхронизация — для того, что реально успело привязаться, даже если вторая
      // половина пары провалилась: riot-lol не должен ждать riot-tft, чтобы получить ранг.
      const accounts = await deps.linking.listAccounts(userId);
      for (const account of accounts.filter((a) => linkedIds.includes(a.id))) {
        await deps.rankSync.syncAccount(account);
      }

      if (partialFailure) {
        // Откатывать нечем (нет транзакции — см. комментарий выше), поэтому единственный
        // честный вариант — сказать игроку, что именно привязалось, а что нет, вместо
        // голой ошибки второй итерации (которая иначе выглядела бы так, будто не
        // привязалось вообще ничего). describeForUser — та же классификация, что и в
        // роутере: текст UserError показывается как есть, для прочего — общая фраза с
        // incidentId, который дальше в лог кладём сами (роутер этого сбоя уже не увидит).
        const described = describeForUser(partialFailure.error);
        if (described.incidentId) {
          ctx.logger.error(
            { err: partialFailure.error, incidentId: described.incidentId, userId, failedProvider: partialFailure.provider, linkedProviders },
            'riot: вторая привязка из пары LoL/TFT не удалась после первой',
          );
        } else {
          ctx.logger.info(
            { err: partialFailure.error, userId, failedProvider: partialFailure.provider, linkedProviders },
            'riot: вторая привязка из пары LoL/TFT не удалась после первой (ожидаемая ошибка)',
          );
        }

        const shortLabel: Record<'riot-lol' | 'riot-tft', string> = { 'riot-lol': 'LoL', 'riot-tft': 'TFT' };
        const done = linkedProviders.map((p) => shortLabel[p]).join(' и ');
        const failedLabel = shortLabel[partialFailure.provider];

        await interaction.followUp({
          content:
            `Частично: **${verified.displayName}** привязан и подтверждён для ${done}. ` +
            `Для ${failedLabel} не получилось: ${described.text} ` +
            `Повтори \`/link riot\` с тем же Riot ID и платформой, чтобы досвязать ${failedLabel} — ${done} трогать не придётся.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.followUp({
        content: `Готово: **${verified.displayName}** привязан и подтверждён — сразу и для LoL, и для TFT. Ранги подтянутся в течение минуты.`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
