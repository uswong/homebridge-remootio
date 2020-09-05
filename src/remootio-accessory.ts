/* Copyright (C) 2020 Ronnie Pettersson. All rights reserved
 *
 *  remootio-accessory.ts: Base class for Remootio accessories
 *
 */

import {
  API,
  HAP,
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  Logging,
  Characteristic,
  PlatformAccessory,
} from 'homebridge';

import { RemootioPlatform } from './platform';

import RemootioDevice = require('remootio-api-client');

// Here are a subset of the Remootio API payloads sent by the device over web sockets
type RemootioEncryptedPayload = {
  type: 'ENCRYPTED';
  data: {
    payload: string;
    iv: string;
  };
  mac: string;
};
type RemootioError = {
  type: 'ERROR';
  errorMessage: string;
};
type RemootioPing = {
  type: 'PING';
};
type RemootioHello = {
  type: 'HELLO';
  apiVersion: number;
  message: string;
};

interface RemootioChallenge {
  challenge: {
    sessionKey: string;
    initialActionId: number;
  };
}

interface RemootioEvent {
  event: {
    cnt: number;
    type: string;
    state: string;
    t100ms: number;
    data?: {
      keyNr?: number;
      keyType?: string;
      via?: string;
      imeOpen100ms?: number;
    };
  };
}

interface RemootioResponse {
  response: {
    type: string;
    id: number;
    success: boolean;
    state: string;
    t100ms: number;
    relayTriggered: boolean;
    errorCode: string;
  };
}

type RemootioTypedFrame = RemootioEncryptedPayload | RemootioError | RemootioPing | RemootioHello;

type RemootioFrame = RemootioTypedFrame & RemootioChallenge;

type RemootioDecryptedPayload = RemootioEvent & RemootioResponse;

const garageDoorOpenerStateToString: string[] = ['OPEN', 'CLOSED', 'OPENING', 'CLOSING', 'STOPPED'];

export class RemootioHomebridgeAccessory {
  private readonly log: Logging;
  private readonly api: API;
  private readonly hap: HAP;
  private readonly accessory: PlatformAccessory;
  private readonly platform: RemootioPlatform;

  private device!: RemootioDevice;

  // Configuration parameters
  private name!: string;
  private ipAddress!: string;
  private apiSecretKey!: string;
  private apiAuthKey!: string;
  private pingInterval = 60000;

  private readonly currentDoorState!: typeof Characteristic.CurrentDoorState;
  private readonly targetDoorState!: typeof Characteristic.TargetDoorState;

  private currentState = -1; // To detect whether we have recevied an update
  private targetState = -1;

  //private garageDoorOpenerService!: Service;
  //private informationService!: Service;

  // The constructor initializes variables

  constructor(platform: RemootioPlatform, accessory: PlatformAccessory) {
    this.accessory = accessory;
    this.api = platform.api;
    this.hap = this.api.hap;
    this.log = platform.log;
    this.platform = platform;

    this.currentDoorState = this.hap.Characteristic.CurrentDoorState;
    this.targetDoorState = this.hap.Characteristic.TargetDoorState;

    this.configureDevice();
  }

  configureDevice(): void {
    const accessory = this.accessory;
    const config = this.accessory.context.device;

    if (
      config === undefined ||
      config.ipAddress === undefined ||
      config.apiSecretKey === undefined ||
      config.apiAuthKey === undefined
    ) {
      this.log.error('Missing required config parameters, exiting');
      return;
    }

    // From configuration of this accessory
    this.name = config.name || 'Remootio Device';
    this.ipAddress = config.ipAddress;
    this.apiSecretKey = config.apiSecretKey;
    this.apiAuthKey = config.apiAuthKey;

    this.log.debug('IP: ' + this.ipAddress);
    this.log.debug('SK: ' + this.apiSecretKey);
    this.log.debug('AK: ' + this.apiAuthKey);

    // Add a new Remootio device using remootio-api-client library
    this.device = new RemootioDevice(this.ipAddress, this.apiSecretKey, this.apiAuthKey, this.pingInterval);

    // Creating new Garage door opener service
    const garageDoorService = accessory.getService(this.hap.Service.GarageDoorOpener);

    // Clear out stale services.
    if (garageDoorService) {
      accessory.removeService(garageDoorService);
    }

    // Add the garage door opener service to the accessory.
    const garageDoorOpenerService = new this.hap.Service.GarageDoorOpener(this.name);

    // Registering the listeners for the required characteristics
    // https://developers.homebridge.io/#/service/GarageDoorOpener
    accessory
      .addService(garageDoorOpenerService)
      .getCharacteristic(this.hap.Characteristic.CurrentDoorState)!
      .on(CharacteristicEventTypes.GET, this.getCurrentStateHandler.bind(this));

    accessory
      .getService(this.hap.Service.GarageDoorOpener)!
      .getCharacteristic(this.hap.Characteristic.TargetDoorState)!
      .on(CharacteristicEventTypes.GET, this.getTargetStateHandler.bind(this));

    accessory
      .getService(this.hap.Service.GarageDoorOpener)!
      .getCharacteristic(this.hap.Characteristic.TargetDoorState)!
      .on(CharacteristicEventTypes.SET, this.setTargetStateHandler.bind(this));

    accessory
      .getService(this.hap.Service.GarageDoorOpener)!
      .getCharacteristic(this.hap.Characteristic.ObstructionDetected)!
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        // Dummy return as this is not supported by Remootio devices at this point
        this.log.debug('[%s] ObstructionDetected was requested', this.name);
        callback(null, false);
      });

    // Update the manufacturer information for this device.
    accessory
      .getService(this.hap.Service.AccessoryInformation)!
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'Remootio')
      .setCharacteristic(this.hap.Characteristic.Model, 'Remootio');

    // Registering the listeners for the Remootio API client
    // https://documents.remootio.com/docs/WebsocketApiDocs.pdf
    this.device.on('error', (err) => {
      this.log.error('[%s] whoops! there was an error: %s', this.name, err);
    });

    this.device.addListener('connected', () => {
      this.log.info('[%s] Connected', this.name);
      this.device.authenticate(); //Authenticate the session (required)
    });

    this.device.addListener('authenticated', () => {
      this.log.info('[%s] Authenticated', this.name);
      //this.device.sendQuery();
    });

    this.device.addListener('disconnect', (msg: string) => {
      this.log.info('[%s] Disconnected: %s', this.name, msg);
      //this.device.sendQuery();
    });

    this.device.addListener('incomingmessage', (frame: RemootioFrame, decryptedPayload: RemootioDecryptedPayload) => {
      this.handleIncomingMessage(frame, decryptedPayload);
    });

    this.device.addListener('outgoingmessage', (frame: RemootioTypedFrame) => {
      this.log.debug('[%s] Outgoing: %s', this.name, frame.type);
    });

    // Request to connect with Remootio device with auto-reconnect = true
    this.device.connect(true);

    this.log.info('[%s] Finished initializing!', this.name);
  }

  handleIncomingMessage(frame: RemootioFrame, decryptedPayload: RemootioDecryptedPayload): void {
    if (decryptedPayload !== undefined) {
      this.log.debug('[%s] Incoming:\n%s', this.name, JSON.stringify(decryptedPayload));
      if (decryptedPayload.event !== undefined && decryptedPayload.event.state !== undefined) {
        if (decryptedPayload.event.type === 'StateChange') {
          this.setCurrentDoorState(decryptedPayload.event.state);
          // There is only one definite end state, as there is only one sensor indicating when the door is closed.
          // So to sync current and target door state, set target door state to closed when we get a state change to closed
          if (decryptedPayload.event.state === 'closed') {
            this.targetState = this.targetDoorState.CLOSED;
          }
        }
        if (
          decryptedPayload.event.type === 'RelayTrigger' &&
          decryptedPayload.event.state === 'open' &&
          decryptedPayload.event.data?.keyType === 'api key'
        ) {
          this.setCurrentDoorState('closing');
        }
        if (
          decryptedPayload.event.type === 'RelayTrigger' &&
          decryptedPayload.event.state === 'closed' &&
          decryptedPayload.event.data?.keyType === 'api key'
        ) {
          this.setCurrentDoorState('opening');
        }
      }
      if (decryptedPayload.response !== undefined && decryptedPayload.response.state !== undefined) {
        this.log.debug('[%s] Decrypted payload: %s', this.name, decryptedPayload.response.type);
        if (decryptedPayload.response.type === 'QUERY') {
          this.setCurrentDoorState(decryptedPayload.response.state);
        }
      }
    } else {
      if (frame !== undefined) {
        if (frame.challenge === undefined && frame.type !== undefined) {
          this.log.debug('[%s] Incoming: %s', this.name, frame.type);
        } else if (frame.challenge !== undefined) {
          this.log.debug('[%s] Incoming: CHALLENGE', this.name);
        }
      }
    }
  }

  setCurrentDoorState(state: string) {
    const accessory = this.accessory;
    switch (state) {
      case 'open':
        this.currentState = this.currentDoorState.OPEN;
        this.log.info('[%s] Setting current state to OPEN', this.name);
        accessory
          .getService(this.hap.Service.GarageDoorOpener)!
          .getCharacteristic(this.hap.Characteristic.CurrentDoorState)!
          .updateValue(this.currentDoorState.OPEN);
        break;
      case 'closed':
        this.currentState = this.currentDoorState.CLOSED;
        this.log.info('[%s] Setting current state to CLOSED', this.name);
        accessory
          .getService(this.hap.Service.GarageDoorOpener)!
          .getCharacteristic(this.hap.Characteristic.CurrentDoorState)!
          .updateValue(this.currentDoorState.CLOSED);
        break;
      case 'opening':
        this.currentState = this.currentDoorState.OPENING;
        this.log.info('[%s] Setting current state to OPENING', this.name);
        accessory
          .getService(this.hap.Service.GarageDoorOpener)!
          .getCharacteristic(this.hap.Characteristic.CurrentDoorState)!
          .updateValue(this.currentDoorState.OPENING);
        break;
      case 'closing':
        this.currentState = this.currentDoorState.CLOSING;
        this.log.info('[%s] Setting current state to CLOSING', this.name);
        accessory
          .getService(this.hap.Service.GarageDoorOpener)!
          .getCharacteristic(this.hap.Characteristic.CurrentDoorState)!
          .updateValue(this.currentDoorState.CLOSING);
        break;
    }
  }

  getCurrentStateHandler(callback: CharacteristicGetCallback): void {
    this.log.debug(
      '[%s] getCurrentStateHandler: Current door state: [%s]',
      this.name,
      this.currentState === this.currentDoorState.OPEN ? 'Open' : 'Closed',
    );
    if (this.currentState < 0) {
      callback(new Error('No value available'));
    } else {
      // Always return current state, so that the server does not emit an event to HAP
      callback(null, this.currentState);
    }
    // Always send a query request to the garage door opener. When the request returned, send the event via setCurrentDoorState()
    this.device.sendQuery();
  }

  getTargetStateHandler(callback: CharacteristicGetCallback): void {
    this.log.debug(
      '[%s] getTargetStateHandler: Target door state: [%s]',
      this.name,
      this.targetState === this.targetDoorState.OPEN ? 'Open' : 'Closed',
    );
    if (this.targetState < 0) {
      if (this.currentState < 0) {
        callback(new Error('No value available'));
        return;
      } else {
        this.targetState = this.currentState;
        this.log.info('[%s] Target state is uninitialized, setting target state same as current state', this.name);
      }
    }
    callback(null, this.targetState);
  }

  /*
   * This method implements the logic for sending open or close to the devices.
   * In current implementation, it will not resend a command if the target door state is the same as previous call.
   */
  setTargetStateHandler(newValue: CharacteristicValue, callback: CharacteristicSetCallback): void {
    // call sendOpen or sendClose based on value

    if (newValue === undefined || newValue === null) {
      this.log.debug('[%s] setTargetStateHandler: invalid new value', this.name);
      callback(new Error('no value'));
      return;
    }
    const oldState = this.targetState;
    const newState = newValue as number;

    this.log.info(
      '[%s] setTargetStateHandler: New value: %s Old value: %s',
      this.name,
      garageDoorOpenerStateToString[newState],
      garageDoorOpenerStateToString[oldState],
    );
    if (newState !== oldState) {
      if (!this.device.isConnected || !this.device.isAuthenticated) {
        this.log.warn('[%s] Device is not connected', this.name);
        return callback(new Error('Not Connected'));
      }
      this.targetState = newState;
      if (newState === this.targetDoorState.OPEN) {
        this.log.info('[%s] Sending sendOpen()', this.name);
        this.device.sendOpen();
      } else if (newState === this.targetDoorState.CLOSED) {
        this.log.info('[%s] Sending sendClose()', this.name);
        this.device.sendClose();
      }
    }

    callback(null);
  }
}
