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
const { isIPv4, isIPv6 } = require('net');

const SECRET_BUFFER_LENGTH = 4;
const NETWORK_BUFFER_LENGTH = 1;
const PREFIX_BUFFER_LENGTH = 1;
const BYTES_2 = 2;
const BYTES_4 = 4;
const BYTES_16 = 16;
const BYTES_64 = 64;
const BYTES_128 = 128;

const IPV6_UNCOMPRESSED_PART_LENGTH = 4;
const IPV6_UNCOMPRESSED_COLON_COUNT = 7;
const COLON_REGEX = /:/g;
const DOUBLE_COLON_REGEX = /::/g;

const IPV6_PEER_HOST_REGEX = /\[([^\[]*)\]/;
const IPV6_PEER_PORT_REGEX = /\[[^\[]*\]:([^:]*)$/;

const PROTOCOL_IPV4 = 'IPv4';
const PROTOCOL_IPV6 = 'IPv6';

const IPV6_HYBRID_REGEX = /ffff:([0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3})$/;

const NETWORK = {
  NET_IPV4: 0,
  NET_IPV6: 1,
  NET_PRIVATE: 2,
  NET_LOCAL: 3,
  NET_OTHER: 4,
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

const normalizeIPv6Address = (ipv6Address) => {
  const colonCount = (ipv6Address.match(COLON_REGEX) || []).length;
  const colonDiff = IPV6_UNCOMPRESSED_COLON_COUNT - colonCount;
  const fullColonAddress = ipv6Address.replace(DOUBLE_COLON_REGEX, `::${':'.repeat(colonDiff)}`);
  return fullColonAddress.split(':')
    .map((part) => {
      if (part === '') {
        return '0';
      }
      return parseInt(part, 16).toString(16);
    })
    .join(':');
};

const normalizeAddress = (address) => {
  let protocol;
  if (isIPv6(address)) {
    const nestedIPV4Matches = address.match(IPV6_HYBRID_REGEX);
    if (nestedIPV4Matches) {
      protocol = PROTOCOL_IPV4;
      return {
        protocol,
        address: nestedIPV4Matches[1],
      };
    }
    protocol = PROTOCOL_IPV6;
    return {
      protocol,
      address: normalizeIPv6Address(address),
    };
  }
  protocol = PROTOCOL_IPV4;
  return {
    protocol,
    address
  };
};

const isPrivate = (address) => {
  if (isIPv4(address)) {
    const addressParts = address.split('.');
    const addressFirstNumber = parseInt(addressParts[0]);
    const addressSecondNumber = parseInt(addressParts[1]);

    return addressFirstNumber === 10 ||
      (addressFirstNumber === 172 &&
      addressSecondNumber >= 16 && addressSecondNumber <= 31);
  }
  const firstAddressPart = address.split(':')[0];
  const addressPrefix = firstAddressPart.slice(0, 2);
  return addressPrefix === 'fc' || addressPrefix === 'fd';
};

const isLocal = (address) => {
  if (isIPv4(address)) {
    const addressParts = address.split('.');
    const addressFirstNumber = parseInt(addressParts[0]);

    return addressFirstNumber === 127 || addressFirstNumber === 0;
  }
  return normalizeIPv6Address(address) === '0:0:0:0:0:0:0:1';
}

const getNetwork = (address) => {
  let preva = address;
  if (isLocal(address)) {
    return NETWORK.NET_LOCAL;
  }

  if (isPrivate(address)) {
    return NETWORK.NET_PRIVATE;
  }

  if (isIPv4(address)) {
    return NETWORK.NET_IPV4;
  }

  if (isIPv6(address)) {
    return NETWORK.NET_IPV6;
  }

  return NETWORK.NET_OTHER;
};

const getIPV6Bytes = (ipv6Address) => {
  const normalizedAddress = normalizeIPv6Address(ipv6Address);
  const addressBuffers = normalizedAddress.split(':').map((part) => {
    const lengthDiff = IPV6_UNCOMPRESSED_PART_LENGTH - part.length;
    const uncompressedPart = `${'0'.repeat(lengthDiff)}${part}`;
    return Buffer.from(uncompressedPart, 'hex');
  });
  return Buffer.concat(addressBuffers);
};

const getIPV4Bytes = (ipv4Address) => {
  const addressBuffers = ipv4Address.split('.').map((part) => {
    const partBuffer = Buffer.alloc(1);
    partBuffer.writeUInt8(parseInt(part));
    return partBuffer;
  });
  return Buffer.concat(addressBuffers);
};

const getBucketId = (options) => {
  const { secret, targetAddress, peerType, bucketCount } = options;

  const secretBytes = Buffer.alloc(SECRET_BUFFER_LENGTH);
  secretBytes.writeUInt32BE(secret, 0);

  const network = getNetwork(targetAddress);
  if (network === NETWORK.NET_OTHER) {
    throw Error('IP address is unsupported.');
  }

  const networkBytes = Buffer.alloc(NETWORK_BUFFER_LENGTH);
  networkBytes.writeUInt8(network, 0);

  if (network === NETWORK.NET_LOCAL || network === NETWORK.NET_PRIVATE) {
    return (
      hash(Buffer.concat([secretBytes, networkBytes])).readUInt32BE(0) %
      bucketCount
    );
  }

  const addressBytes = network === NETWORK.NET_IPV6 ?
    getIPV6Bytes(targetAddress) : getIPV4Bytes(targetAddress);

  const bucketBytes = Buffer.concat([
    secretBytes,
    networkBytes,
    addressBytes,
  ]);

  return hash(bucketBytes).readUInt32BE(0) % bucketCount;
};

const getPeerIdFromPeerInfo = (peerInfo) => {
  const { protocol, address } = normalizeAddress(peerInfo.ipAddress);
  if (protocol === PROTOCOL_IPV6) {
    return `[${address}]:${peerInfo.wsPort}`;
  }
  return `${address}:${peerInfo.wsPort}`;
};

const getHostFromPeerId = (peerId) => {
  let peerIPV6Host = (peerId.match(IPV6_PEER_HOST_REGEX) || [])[1];
  if (peerIPV6Host) {
    const { address } = normalizeAddress(peerIPV6Host);
    return address;
  }
  return peerId.split(':')[0];
};

const getPortFromPeerId = (peerId) => {
  let peerIPV6Port = (peerId.match(IPV6_PEER_PORT_REGEX) || [])[1];
  if (peerIPV6Port) {
    return parseInt(peerIPV6Port);
  }
  return parseInt(peerId.split(':')[1]);
};

const normalizePeerId = (peerId) => {
  const host = getHostFromPeerId(peerId);
  const port = getPortFromPeerId(peerId);
  if (isIPv4(host)) {
    return `${host}:${port}`;
  }
  return `[${host}]:${port}`;
}

function wait(duration) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve();
    }, duration);
  });
}

module.exports = {
  PEER_TYPE,
  hash,
  isPrivate,
  isLocal,
  getNetwork,
  getBucketId,
  getPeerIdFromPeerInfo,
  getHostFromPeerId,
  getPortFromPeerId,
  normalizeAddress,
  normalizePeerId,
  PROTOCOL_IPV4,
  PROTOCOL_IPV6,
  wait,
};
