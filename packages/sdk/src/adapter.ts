import type { Adapter } from './types';

/** Identity with a type: the same `Adapter` whether the platform calls it in-process or `syncRemote` does over HTTP. */
export const defineAdapter = <A extends Adapter>(adapter: A): A => adapter;
