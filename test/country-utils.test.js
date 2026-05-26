'use strict';
const assert = require('node:assert');
const cu = require('../src/scripts/lib/country-utils.js');

// parseBlocklistText
assert.deepStrictEqual(
  cu.parseBlocklistText('UCGs-yDFkfHDbeQcApWkTtxg\nUCSajd4i4WsFI4JxsJ_vYbTw\n'),
  ['UCGs-yDFkfHDbeQcApWkTtxg', 'UCSajd4i4WsFI4JxsJ_vYbTw'],
  'parses valid IDs');
assert.deepStrictEqual(
  cu.parseBlocklistText('# comment\n// comment\n\n  UCGs-yDFkfHDbeQcApWkTtxg  \n'),
  ['UCGs-yDFkfHDbeQcApWkTtxg'],
  'skips comments/blanks, trims');
assert.deepStrictEqual(
  cu.parseBlocklistText('UCGs-yDFkfHDbeQcApWkTtxg\nUCGs-yDFkfHDbeQcApWkTtxg'),
  ['UCGs-yDFkfHDbeQcApWkTtxg'],
  'dedupes');
assert.deepStrictEqual(
  cu.parseBlocklistText('notachannelid\nUC-tooshort\n<script>'),
  [],
  'rejects malformed IDs');
assert.deepStrictEqual(cu.parseBlocklistText(null), [], 'null -> []');

// compileCountryList
assert.deepStrictEqual(
  cu.compileCountryList(['// Add your country filters below', '', 'Israel', '  Russia  ']),
  ['israel', 'russia'],
  'lowercases, trims, skips comments/blanks');
assert.deepStrictEqual(
  cu.compileCountryList(['Israel', 'israel', 'ISRAEL']),
  ['israel'],
  'dedupes case-insensitively');
assert.deepStrictEqual(cu.compileCountryList('Israel'), [], 'non-array -> []');

// blockedChannelIdsByCountry
assert.deepStrictEqual(
  cu.blockedChannelIdsByCountry(
    { UCaaa: 'Israel', UCbbb: 'France', UCccc: null, UCddd: 'israel' },
    ['israel']).sort(),
  ['UCaaa', 'UCddd'],
  'matches country case-insensitively, ignores null and non-matches');
assert.deepStrictEqual(
  cu.blockedChannelIdsByCountry({ UCaaa: 'Israel' }, []),
  [],
  'empty blocklist -> []');

console.log('country-utils: all assertions passed');
