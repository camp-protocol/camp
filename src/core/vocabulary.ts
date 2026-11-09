import { z } from 'zod';
import {
  CommandBase,
  EphemeralBase,
  HelloMessage,
  ProtocolErrorMessage,
  SignalBase,
  eventMessage,
  resultMessage,
  welcomeMessage,
} from './envelope.ts';
import type { CAMP_VERSION } from './version.ts';

/**
 * アプリの「語彙」を渡すと、CAMP のメッセージ一式（検証用のスキーマと型）を組み立てる。
 *
 *   const quiz = defineVocabulary({
 *     commands: { ANSWER: z.object({ choice: z.number() }) },
 *     events: ['ANSWERED'],
 *     rejectReasons: ['CLOSED'],
 *     snapshot: z.object({ answers: z.record(z.string(), z.number()) }),
 *   });
 *
 * プロトコルが使う理由コード（CORE_REJECT_REASONS）は自動で足す。
 */

/** プロトコル自身が返す拒否理由。アプリの理由コードに自動で足される */
export const CORE_REJECT_REASONS = ['INVALID_PAYLOAD', 'UNKNOWN_TYPE', 'NOT_AUTHORIZED', 'SPECTATOR', 'STALE_VERSION'] as const;
export type CoreRejectReason = (typeof CORE_REJECT_REASONS)[number];

type Schemas = Record<string, z.ZodType>;
type Names = readonly string[];
type Camp = typeof CAMP_VERSION;

export type CommandOf<C extends Schemas> = {
  [K in keyof C & string]: {
    camp: Camp;
    kind: 'command';
    type: K;
    commandId: string;
    sentAt: string;
    expected?: { rev: string } | undefined;
    payload: z.output<C[K]>;
  };
}[keyof C & string];

export type EphemeralOf<P extends Schemas> = {
  [K in keyof P & string]: { camp: Camp; kind: 'ephemeral'; type: K; senderId?: string | undefined; payload: z.output<P[K]> };
}[keyof P & string];

export type SignalOf<G extends Schemas> = {
  [K in keyof G & string]: { camp: Camp; kind: 'signal'; type: K; payload: z.output<G[K]> };
}[keyof G & string];

export interface EventOf<E extends Names, S extends z.ZodType> {
  camp: Camp;
  kind: 'event';
  type: E[number];
  seq: number;
  correlationId: string | null;
  actorId: string | null;
  detail: Record<string, unknown>;
  snapshot: z.output<S>;
}

export interface WelcomeOf<S extends z.ZodType> {
  camp: Camp;
  kind: 'welcome';
  participantId: string | null;
  /** つなぎ直し用の合言葉（本人にだけ届く。観覧なら null） */
  resumeToken?: string | null;
  snapshot: z.output<S>;
}

export interface ResultOf<R extends Names> {
  camp: Camp;
  kind: 'result';
  commandId: string;
  ok: boolean;
  reason: R[number] | CoreRejectReason | null;
}

export interface VocabularyDef<C extends Schemas, E extends Names, R extends Names, S extends z.ZodType, P extends Schemas, G extends Schemas> {
  commands: C;
  events: E;
  rejectReasons: R;
  snapshot: S;
  ephemerals?: P;
  signals?: G;
}

export interface Vocabulary<C extends Schemas, E extends Names, R extends Names, S extends z.ZodType, P extends Schemas, G extends Schemas> {
  readonly commands: C;
  readonly ephemerals: P;
  readonly signals: G;
  readonly EventType: z.ZodType<E[number]>;
  readonly RejectReason: z.ZodType<R[number] | CoreRejectReason>;
  readonly Snapshot: S;
  readonly CommandMessage: z.ZodType<CommandOf<C>>;
  readonly EphemeralMessage: z.ZodType<EphemeralOf<P>>;
  readonly SignalMessage: z.ZodType<SignalOf<G>>;
  readonly EventMessage: z.ZodType<EventOf<E, S>>;
  readonly WelcomeMessage: z.ZodType<WelcomeOf<S>>;
  readonly ResultMessage: z.ZodType<ResultOf<R>>;
  readonly ClientMessage: z.ZodType<HelloMessage | CommandOf<C> | EphemeralOf<P> | SignalOf<G>>;
  readonly ServerMessage: z.ZodType<
    ProtocolErrorMessage | WelcomeOf<S> | EventOf<E, S> | ResultOf<R> | EphemeralOf<P>
  >;
  /** この語彙が知っている Command の種類か（知らなければ UNKNOWN_TYPE を返す） */
  hasCommand(type: unknown): boolean;
}

function unionOf(items: z.ZodType[]): z.ZodType {
  if (items.length === 0) return z.never();
  if (items.length === 1) return items[0]!;
  return z.union(items as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

export function defineVocabulary<
  C extends Schemas,
  const E extends Names,
  const R extends Names,
  S extends z.ZodType,
  P extends Schemas = Record<never, never>,
  G extends Schemas = Record<never, never>,
>(def: VocabularyDef<C, E, R, S, P, G>): Vocabulary<C, E, R, S, P, G> {
  const ephemerals = (def.ephemerals ?? {}) as P;
  const signals = (def.signals ?? {}) as G;
  const commandTypes = new Set(Object.keys(def.commands));
  const reasons = [...new Set([...def.rejectReasons, ...CORE_REJECT_REASONS])] as [string, ...string[]];
  const RejectReason = z.enum(reasons);
  const EventType = z.enum(def.events as unknown as [string, ...string[]]);

  const CommandMessage = unionOf(
    Object.entries(def.commands).map(([type, payload]) => CommandBase.extend({ type: z.literal(type), payload })),
  );
  const EphemeralMessage = unionOf(
    Object.entries(ephemerals).map(([type, payload]) => EphemeralBase.extend({ type: z.literal(type), payload })),
  );
  const SignalMessage = unionOf(
    Object.entries(signals).map(([type, payload]) => SignalBase.extend({ type: z.literal(type), payload })),
  );
  const EventMessage = eventMessage(EventType, def.snapshot);
  const WelcomeMessage = welcomeMessage(def.snapshot);
  const ResultMessage = resultMessage(RejectReason);
  const has = (o: object) => Object.keys(o).length > 0;

  return {
    commands: def.commands,
    ephemerals,
    signals,
    EventType: EventType as never,
    RejectReason: RejectReason as never,
    Snapshot: def.snapshot,
    CommandMessage: CommandMessage as never,
    EphemeralMessage: EphemeralMessage as never,
    SignalMessage: SignalMessage as never,
    EventMessage: EventMessage as never,
    WelcomeMessage: WelcomeMessage as never,
    ResultMessage: ResultMessage as never,
    ClientMessage: unionOf([HelloMessage, CommandMessage, ...(has(ephemerals) ? [EphemeralMessage] : []), ...(has(signals) ? [SignalMessage] : [])]) as never,
    ServerMessage: unionOf([
      ProtocolErrorMessage,
      WelcomeMessage,
      EventMessage,
      ResultMessage,
      ...(has(ephemerals) ? [EphemeralMessage] : []),
    ]) as never,
    hasCommand: (type) => typeof type === 'string' && commandTypes.has(type),
  };
}

/** 語彙から型を取り出すための補助（推論しない位置は any にして、変性の違いで外れないようにする） */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyVocabulary = Vocabulary<any, any, any, any, any, any>;
type C_<V> = V extends Vocabulary<infer C, any, any, any, any, any> ? C : never;
type E_<V> = V extends Vocabulary<any, infer E, any, any, any, any> ? E : never;
type R_<V> = V extends Vocabulary<any, any, infer R, any, any, any> ? R : never;
type S_<V> = V extends Vocabulary<any, any, any, infer S, any, any> ? S : never;
type P_<V> = V extends Vocabulary<any, any, any, any, infer P, any> ? P : never;
type G_<V> = V extends Vocabulary<any, any, any, any, any, infer G> ? G : never;

export type CommandMessageOf<V> = CommandOf<C_<V>>;
export type CommandTypeOf<V> = keyof C_<V> & string;
export type CommandPayloadOf<V, T extends string> = T extends keyof C_<V> ? z.input<C_<V>[T]> : never;
export type EventTypeOf<V> = E_<V>[number];
export type EventMessageOf<V> = EventOf<E_<V>, S_<V>>;
export type WelcomeMessageOf<V> = WelcomeOf<S_<V>>;
export type SnapshotOf<V> = z.output<S_<V>>;
export type RejectReasonOf<V> = R_<V>[number] | CoreRejectReason;
export type EphemeralMessageOf<V> = EphemeralOf<P_<V>>;
export type EphemeralTypeOf<V> = keyof P_<V> & string;
export type EphemeralPayloadOf<V, T extends string> = T extends keyof P_<V> ? z.input<P_<V>[T]> : never;
export type SignalMessageOf<V> = SignalOf<G_<V>>;
export type SignalTypeOf<V> = keyof G_<V> & string;
export type SignalPayloadOf<V, T extends string> = T extends keyof G_<V> ? z.input<G_<V>[T]> : never;
