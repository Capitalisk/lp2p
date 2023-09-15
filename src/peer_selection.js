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

const shuffle = require('lodash.shuffle');

const getUniquePeersbyIp = (peerList) => {
  const peerMap = new Map();

  for (const peer of peerList) {
    const tempPeer = peerMap.get(peer.ipAddress);
    if (tempPeer) {
      if (peer.height > tempPeer.height) {
        peerMap.set(peer.ipAddress, peer);
      }
    } else {
      peerMap.set(peer.ipAddress, peer);
    }
  }

  return [...peerMap.values()];
};

const selectPeersForRequest = (input) => {
  const { peers } = input;
  const peerLimit = input.peerLimit;

  if (peers.length === 0) {
    return [];
  }

  if (peerLimit === undefined) {
    return shuffle(peers);
  }

  return shuffle(peers).slice(0, peerLimit);
};

const selectPeersForSend = (input) => {
  const shuffledPeers = shuffle(input.peers);
  const peerLimit = input.peerLimit;
  // tslint:disable: no-magic-numbers
  const halfPeerLimit = Math.round(peerLimit / 2);

  const outboundPeers = shuffledPeers.filter(
    (peerInfo) => peerInfo.kind === 'outbound',
  );

  const inboundPeers = shuffledPeers.filter(
    (peerInfo) => peerInfo.kind === 'inbound',
  );

  // tslint:disable: no-let
  let shortestPeersList;
  // tslint:disable: no-let
  let longestPeersList;

  if (outboundPeers.length < inboundPeers.length) {
    shortestPeersList = outboundPeers;
    longestPeersList = inboundPeers;
  } else {
    shortestPeersList = inboundPeers;
    longestPeersList = outboundPeers;
  }

  const selectedFirstKindPeers = shortestPeersList.slice(0, halfPeerLimit);
  const remainingPeerLimit = peerLimit - selectedFirstKindPeers.length;
  const selectedSecondKindPeers = longestPeersList.slice(0, remainingPeerLimit);

  return selectedFirstKindPeers.concat(selectedSecondKindPeers);
};

const selectPeersForConnection = (input) => {
  let moduleCount;
  if (input.nodeInfo && input.nodeInfo.modules) {
    moduleCount = Object.keys(input.nodeInfo.modules).length + 1;
  } else {
    moduleCount = 1;
  }
  let peerLimit = (input.maxOutboundPeerCount * moduleCount) - input.outboundPeerCount;
  if (peerLimit && peerLimit < 0) {
    return [];
  }

  if (
    peerLimit === undefined ||
    peerLimit >= input.disconnectedTriedPeers.length + input.disconnectedNewPeers.length
  ) {
    return [...input.disconnectedNewPeers, ...input.disconnectedTriedPeers];
  }

  if (input.disconnectedTriedPeers.length === 0 && input.disconnectedNewPeers.length === 0) {
    return [];
  }

  const x =
    input.disconnectedTriedPeers.length / (input.disconnectedTriedPeers.length + input.disconnectedNewPeers.length);
  const minimumProbability = 0.5;
  const r = Math.max(x, minimumProbability);

  const shuffledTriedPeers = shuffle(input.disconnectedTriedPeers);
  const shuffledNewPeers = shuffle(input.disconnectedNewPeers);

  return [...Array(peerLimit)].map(() => {
    if (shuffledTriedPeers.length !== 0) {
      if (Math.random() < r) {
        // With probability r
        return shuffledTriedPeers.pop();
      }
    }

    if (shuffledNewPeers.length !== 0) {
      // With probability 1-r
      return shuffledNewPeers.pop();
    }

    return shuffledTriedPeers.pop();
  });
};

module.exports = {
  getUniquePeersbyIp,
  selectPeersForRequest,
  selectPeersForSend,
  selectPeersForConnection,
};
