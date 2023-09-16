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
const { DEFAULT_RANDOM_SECRET } = require('../../src/p2p');
const { Peer } = require('../../src/peer');

const initializePeerInfoList = () => {
  const peerOption1 = {
    ipAddress: '204.120.0.15',
    wsPort: 5001,
    height: 545776,
    isDiscoveredPeer: false,
    version: '1.1.1',
    protocolVersion: '1.1',
  };

  const peerOption2 = {
    ipAddress: '204.120.0.16',
    wsPort: 5002,
    height: 545981,
    isDiscoveredPeer: false,
    version: '1.1.1',
    protocolVersion: '1.1',
  };

  const peerOption3 = {
    ipAddress: '204.120.0.17',
    wsPort: 5008,
    height: 645980,
    isDiscoveredPeer: false,
    version: '1.3.1',
    protocolVersion: '1.1',
  };

  const peerOption4 = {
    ipAddress: '204.120.0.18',
    wsPort: 5006,
    height: 645982,
    isDiscoveredPeer: false,
    version: '1.2.1',
    protocolVersion: '1.1',
  };

  const peerOption5 = {
    ipAddress: '204.120.0.19',
    wsPort: 5001,
    height: 645980,
    isDiscoveredPeer: false,
    version: '1.1.1',
    protocolVersion: '1.1',
  };

  return [peerOption1, peerOption2, peerOption3, peerOption4, peerOption5];
};

const initializeLongPeerInfoList = () => {
  let peerInfos = [];
  // Generate a realistic list in which 1 in 4 peers is outbound.
  for (let i = 0; i < 120; i++) {
    peerInfos.push({
      ipAddress: `204.120.0.${i}`,
      wsPort: 5001,
      height: 645980,
      kind: i % 4 === 0 ? 'outbound' : 'inbound',
      isDiscoveredPeer: false,
      version: '1.1.1',
      protocolVersion: '1.1',
    });
  }
  return peerInfos;
};

const initializePeerInfoListWithSuffix = (ipSuffix, qty) => {
  let peerInfos = [];
  for (let i = 0; i < qty; i++) {
    peerInfos.push({
      ipAddress: `${i % 255}.${ipSuffix}`,
      wsPort: 5000 + (i % 40000),
      height: 645980,
      kind: i % 4 === 0 ? 'outbound' : 'inbound',
      isDiscoveredPeer: false,
      version: '1.1.1',
      protocolVersion: '1.1',
    });
  }
  return peerInfos;
};

const initializePeerList = () => {
  return initializePeerInfoList().map(
    (peerInfo) =>
      new Peer(peerInfo, {
        rateCalculationInterval: 1000,
        wsMaxMessageRate: 1000,
        wsMaxMessageRatePenalty: 10,
        secret: DEFAULT_RANDOM_SECRET,
        maxPeerInfoSize: 10000,
        maxPeerDiscoveryResponseLength: 1000,
      }),
  );
};

module.exports = {
  initializePeerInfoList,
  initializeLongPeerInfoList,
  initializePeerInfoListWithSuffix,
  initializePeerList,
};
