#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { publicMcp } from './lib/public-mcp.mjs';

const [name, argument = '{}', ...rest] = process.argv.slice(2);
if (!name || rest.length) throw new Error('Usage: mcp-call.ts <tool> <JSON or @file>');
const args = JSON.parse(argument.startsWith('@') ? await readFile(argument.slice(1), 'utf8') : argument);
console.log(await publicMcp(process.env.TRUST_URL ?? 'http://127.0.0.1:4318', name, args));
