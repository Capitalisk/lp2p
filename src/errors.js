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

class PeerInboundHandshakeError extends Error {
  constructor(
    message,
    statusCode,
    remoteAddress,
    handshakeURL,
  ) {
    super(message);
    this.name = 'PeerInboundHandshakeError';
    this.statusCode = statusCode;
    this.remoteAddress = remoteAddress;
    this.handshakeURL = handshakeURL;
  }
}

class PeerOutboundConnectionError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'PeerOutboundConnectError';
    this.statusCode = statusCode;
  }
}

class RPCResponseError extends Error {
  constructor(message, peerId) {
    super(`[Peer ${peerId}] ${message}`);
    this.name = 'RPCResponseError';
    this.peerId = peerId;
  }
}

class RPCTimeoutError extends Error {
  constructor(message, peerId) {
    super(`[Peer ${peerId}] ${message}`);
    this.name = 'RPCTimeoutError';
    this.peerId = peerId;
  }
}

class InvalidRPCResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRPCResponseError';
  }
}

class RPCResponseAlreadySentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResponseAlreadySentError';
  }
}

class InvalidPeerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPeerError';
  }
}

class RequestFailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestFailError';
  }
}

class SendFailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SendFailError';
  }
}

class InvalidRPCRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRPCRequestError';
  }
}

class InvalidProtocolMessageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidProtocolMessageError';
  }
}

module.exports = {
  PeerInboundHandshakeError,
  PeerOutboundConnectionError,
  RPCResponseError,
  InvalidRPCResponseError,
  RPCTimeoutError,
  RPCResponseAlreadySentError,
  InvalidPeerError,
  RequestFailError,
  SendFailError,
  InvalidRPCRequestError,
  InvalidProtocolMessageError,
};
