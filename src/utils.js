/*
 * Copyright © 2019 Lisk Foundation
 *
 * See the LICENSE file at the top-level directory of this distribution
 * for licensing information.
 *
 * Unless otherwise agreed in a custom licensing agreement with the Lisk Foundation,
 * no part of this software, including this file, may be copied, modified,
 * propagated, or distributed except according to the terms contained in the
 * LICENSE file.
 *
 * Removal or modification of this copyright notice is prohibited.
 *
 */
const crypto = require('crypto');
const { isIPv4 } = require('net');

const SECRET_BUFFER_LENGTH = 4;
const NETWORK_BUFFER_LENGTH = 1;
const PREFIX_BUFFER_LENGTH = 1;
const BYTES_4 = 4;
const BYTES_16 = 16;
const BYTES_64 = 64;
const BYTES_128 = 128;

const NETWORK = {
  NET_IPV4: 0,
  NET_PRIVATE: 1,
  NET_LOCAL: 2,
  NET_OTHER: 3,
};

const PEER_TYPE = {
  NEW_PEER: 'newPeer',
  TRIED_PEER: 'triedPeer',
};

const hash = (data) => {
  const dataHash = crypto.createHash('sha256');
  dataHash.update(data);
  return dataHash.digest();
};

const getIPGroup = (address, groupNumber) => {
  if (groupNumber > 3) {
    throw new Error('Invalid IP group.');
  }

  return parseInt(address.split('.')[groupNumber], 10);
};

// Each byte represents the corresponding subsection of the IP address e.g. AAA.BBB.CCC.DDD
const getIPBytes = (address) => {
  const aBytes = Buffer.alloc(PREFIX_BUFFER_LENGTH);
  aBytes.fill(getIPGroup(address, 0), 0);
  const bBytes = Buffer.alloc(PREFIX_BUFFER_LENGTH);
  bBytes.fill(getIPGroup(address, 1), 0);
  const cBytes = Buffer.alloc(PREFIX_BUFFER_LENGTH);
  cBytes.fill(getIPGroup(address, 2), 0);
  const dBytes = Buffer.alloc(PREFIX_BUFFER_LENGTH);
  dBytes.fill(getIPGroup(address, 3), 0);

  return {
    aBytes,
    bBytes,
    cBytes,
    dBytes,
  };
};

const isPrivate = (address) =>
  getIPGroup(address, 0) === 10 ||
    (getIPGroup(address, 0) === 172 &&
      getIPGroup(address, 1) >= 16 && getIPGroup(address, 1) <= 31);

const isLocal = (address) =>
  getIPGroup(address, 0) === 127 || getIPGroup(address, 0) === 0;
/* tslint:enable no-magic-numbers */

const getNetwork = (address) => {
  if (isLocal(address)) {
    return NETWORK.NET_LOCAL;
  }

  if (isPrivate(address)) {
    return NETWORK.NET_PRIVATE;
  }

  if (isIPv4(address)) {
    return NETWORK.NET_IPV4;
  }

  return NETWORK.NET_OTHER;
};

const getNetgroup = (address, secret) => {
  const secretBytes = Buffer.alloc(SECRET_BUFFER_LENGTH);
  secretBytes.writeUInt32BE(secret, 0);
  const network = getNetwork(address);
  const networkBytes = Buffer.alloc(NETWORK_BUFFER_LENGTH);
  networkBytes.writeUInt8(network, 0);

  // Get prefix bytes of ip address to bucket
  const { aBytes, bBytes } = getIPBytes(address);

  // Check if ip address is unsupported network type
  if (network === NETWORK.NET_OTHER) {
    throw Error('IP address is unsupported.');
  }

  const netgroupBytes = Buffer.concat([
    secretBytes,
    networkBytes,
    aBytes,
    bBytes,
  ]);

  return hash(netgroupBytes).readUInt32BE(0);
};

const getBucketId = (options) => {
  const { secret, targetAddress, peerType, bucketCount } = options;
  const firstMod = peerType === PEER_TYPE.NEW_PEER ? BYTES_16 : BYTES_4;
  const secretBytes = Buffer.alloc(SECRET_BUFFER_LENGTH);
  secretBytes.writeUInt32BE(secret, 0);
  const network = getNetwork(targetAddress);
  const networkBytes = Buffer.alloc(NETWORK_BUFFER_LENGTH);
  networkBytes.writeUInt8(network, 0);

  // Get bytes of ip address to bucket
  const {
    aBytes: targetABytes,
    bBytes: targetBBytes,
    cBytes: targetCBytes,
    dBytes: targetDBytes,
  } = getIPBytes(targetAddress);

  // Check if ip address is unsupported network type
  if (network === NETWORK.NET_OTHER) {
    throw Error('IP address is unsupported.');
  }

  // Seperate buckets for local and private addresses
  if (network !== NETWORK.NET_IPV4) {
    return (
      hash(Buffer.concat([secretBytes, networkBytes])).readUInt32BE(0) %
      bucketCount
    );
  }

  const addressBytes = Buffer.concat([
    targetABytes,
    targetBBytes,
    targetCBytes,
    targetDBytes,
  ]);

  // New peers: k = Hash(random_secret, source_group, group) % 16
  // Tried peers: k = Hash(random_secret, IP) % 4
  const kBytes = Buffer.alloc(firstMod);

  const k =
    peerType === PEER_TYPE.NEW_PEER
      ? hash(
          Buffer.concat([
            secretBytes,
            networkBytes,
            targetABytes,
            targetBBytes,
          ]),
        ).readUInt32BE(0) % firstMod
      : hash(
          Buffer.concat([secretBytes, networkBytes, addressBytes]),
        ).readUInt32BE(0) % firstMod;

  kBytes.writeUInt32BE(k, 0);

  // New peers: b = Hash(random_secret, source_group, k) % 128
  // Tried peers: b = Hash(random_secret, group, k) % 64
  const bucketBytes = Buffer.concat([
    secretBytes,
    networkBytes,
    targetABytes,
    targetBBytes,
    kBytes,
  ]);

  return hash(bucketBytes).readUInt32BE(0) % bucketCount;
};

const constructPeerIdFromPeerInfo = (peerInfo) =>
  `${peerInfo.ipAddress}:${peerInfo.wsPort}`;

module.exports = {
  PEER_TYPE,
  hash,
  getIPGroup,
  getIPBytes,
  isPrivate,
  isLocal,
  getNetwork,
  getNetgroup,
  getBucketId,
  constructPeerIdFromPeerInfo,
};
