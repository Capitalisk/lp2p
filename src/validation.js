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
const { gte: isVersionGTE, valid: isValidVersion } = require('semver');
const { isIP, isNumeric, isPort } = require('validator');
const {
  InvalidPeerError,
  InvalidProtocolMessageError,
  InvalidRPCRequestError,
  InvalidRPCResponseError,
} = require('./errors');

const {
  INCOMPATIBLE_NETWORK_REASON,
  INCOMPATIBLE_PROTOCOL_VERSION_REASON,
} = require('./disconnect_status_codes');
const { getPeerIdFromPeerInfo, normalizeAddress } = require('./utils');

const getByteSize = (object) =>
  Buffer.byteLength(JSON.stringify(object));

const validatePeerAddress = (ip, wsPort) => {
  if (
    !isIP(ip) ||
    !isPort(wsPort.toString())
  ) {
    return false;
  }

  return true;
};

const incomingPeerInfoSanitization = (peerInfo) => {
  const { ip, ...restOfPeerInfo } = peerInfo;

  return {
    ipAddress: ip,
    ...restOfPeerInfo,
  };
};

const outgoingPeerInfoSanitization = (peerInfo) => {
  const { ipAddress, ...restOfPeerInfo } = peerInfo;

  return {
    ip: ipAddress,
    ...restOfPeerInfo,
  };
};

const validatePeerInfoSchema = (rawPeerInfo) => {
  if (!rawPeerInfo) {
    throw new InvalidPeerError(`Invalid peer object`);
  }

  const protocolPeer = rawPeerInfo;
  if (
    !protocolPeer.ip ||
    !protocolPeer.wsPort ||
    !validatePeerAddress(protocolPeer.ip, protocolPeer.wsPort)
  ) {
    throw new InvalidPeerError(
      `Invalid peer ip or port for peer with ip: ${
        protocolPeer.ip
      } and wsPort ${protocolPeer.wsPort}`,
    );
  }

  if (!protocolPeer.version || !isValidVersion(protocolPeer.version)) {
    throw new InvalidPeerError(
      `Invalid peer version for peer with ip: ${protocolPeer.ip}, wsPort ${
        protocolPeer.wsPort
      } and version ${protocolPeer.version}`,
    );
  }

  const version = protocolPeer.version;
  const protocolVersion = protocolPeer.protocolVersion;
  const wsPort = +protocolPeer.wsPort;
  const os = protocolPeer.os ? protocolPeer.os : '';
  const height =
    protocolPeer.height && isNumeric(protocolPeer.height.toString())
      ? +protocolPeer.height
      : 0;
  const { options, ...protocolPeerWithoutOptions } = protocolPeer;
  const peerInfo = {
    ...protocolPeerWithoutOptions,
    ipAddress: protocolPeerWithoutOptions.ip,
    wsPort,
    height,
    os,
    version,
    protocolVersion,
  };

  const { ip, ...peerInfoUpdated } = peerInfo;

  return peerInfoUpdated;
};

const validatePeerInfo = (rawPeerInfo, maxByteSize) => {
  const byteSize = getByteSize(rawPeerInfo);
  if (byteSize > maxByteSize) {
    throw new InvalidRPCResponseError(
      `PeerInfo was larger than the maximum allowed ${maxByteSize} bytes`,
    );
  }

  return validatePeerInfoSchema(rawPeerInfo);
};

const validatePeersInfoList = (rawBasicPeerInfoList, maxPeerInfoListLength, maxPeerInfoByteSize) => {
  if (!rawBasicPeerInfoList) {
    throw new InvalidRPCResponseError('Invalid response type');
  }
  const { peers } = rawBasicPeerInfoList;

  if (Array.isArray(peers)) {
    if (peers.length > maxPeerInfoListLength) {
      throw new InvalidRPCResponseError('PeerInfo list was too long');
    }
    const cleanPeerList = peers.filter(
      peerInfo => getByteSize(peerInfo) < maxPeerInfoByteSize,
    );
    const sanitizedPeerList = cleanPeerList.map(
      validatePeerInfoSchema,
    );

    return sanitizedPeerList;
  } else {
    throw new InvalidRPCResponseError('Invalid response type');
  }
};

const validateRPCRequest = (request) => {
  if (!request) {
    throw new InvalidRPCRequestError('Invalid request');
  }

  const rpcRequest = request;
  if (typeof rpcRequest.procedure !== 'string') {
    throw new InvalidRPCRequestError('Request procedure name is not a string');
  }

  return rpcRequest;
};

const validateProtocolMessage = (message) => {
  if (!message) {
    throw new InvalidProtocolMessageError('Invalid message');
  }

  const protocolMessage = message;
  if (typeof protocolMessage.event !== 'string') {
    throw new InvalidProtocolMessageError('Protocol message is not a string');
  }

  return protocolMessage;
};

const checkProtocolVersionCompatibility = (peerInfo, nodeInfo) => {
  // Backwards compatibility for older peers which do not have a protocolVersion field.
  if (!peerInfo.protocolVersion) {
    try {
      return isVersionGTE(peerInfo.version, nodeInfo.minVersion);
    } catch (error) {
      return false;
    }
  }
  if (typeof peerInfo.protocolVersion !== 'string') {
    return false;
  }

  const peerHardForks = parseInt(peerInfo.protocolVersion.split('.')[0], 10);
  const systemHardForks = parseInt(nodeInfo.protocolVersion.split('.')[0], 10);

  return systemHardForks === peerHardForks && peerHardForks >= 1;
};

const checkPeerCompatibility = (peerInfo, nodeInfo) => {
  if (!checkProtocolVersionCompatibility(peerInfo, nodeInfo)) {
    return {
      success: false,
      errors: [INCOMPATIBLE_PROTOCOL_VERSION_REASON],
    };
  }

  return {
    success: true,
  };
};

const sanitizePeerInfo = (peerInfo) => {
  const { ipAddress, ...remainingPeerInfo } = peerInfo;
  return {
    ipAddress: normalizeAddress(ipAddress).address,
    ...remainingPeerInfo,
  };
};

const sanitizePeerLists = (lists, nodeInfo) => {
  const blacklistedPeers = [...lists.blacklistedPeers];

  const blacklistedIPs = blacklistedPeers.map(peerInfo => peerInfo.ipAddress);

  const seedPeers = lists.seedPeers
    .map(sanitizePeerInfo)
    .filter(peerInfo => {
      if (blacklistedIPs.includes(peerInfo.ipAddress)) {
        return false;
      }

      return true;
    });

  const fixedPeers = lists.fixedPeers
    .map(sanitizePeerInfo)
    .filter(peerInfo => {
      if (blacklistedIPs.includes(peerInfo.ipAddress)) {
        return false;
      }

      return true;
    });

  const whitelisted = lists.whitelisted
    .map(sanitizePeerInfo)
    .filter(peerInfo => {
      if (blacklistedIPs.includes(peerInfo.ipAddress)) {
        return false;
      }

      if (
        fixedPeers
          .map(getPeerIdFromPeerInfo)
          .includes(getPeerIdFromPeerInfo(peerInfo))
      ) {
        return false;
      }

      if (
        seedPeers
          .map(getPeerIdFromPeerInfo)
          .includes(getPeerIdFromPeerInfo(peerInfo))
      ) {
        return false;
      }

      return true;
    });

  const previousPeers = lists.previousPeers
    .map(sanitizePeerInfo)
    .filter(peerInfo => {
      if (blacklistedIPs.includes(peerInfo.ipAddress)) {
        return false;
      }

      return true;
    });

  return {
    blacklistedPeers,
    seedPeers,
    fixedPeers,
    whitelisted,
    previousPeers,
  };
};

module.exports = {
  getByteSize,
  validatePeerAddress,
  incomingPeerInfoSanitization,
  outgoingPeerInfoSanitization,
  validatePeerInfoSchema,
  validatePeerInfo,
  validatePeersInfoList,
  validateRPCRequest,
  validateProtocolMessage,
  checkProtocolVersionCompatibility,
  checkPeerCompatibility,
  sanitizePeerLists,
};
