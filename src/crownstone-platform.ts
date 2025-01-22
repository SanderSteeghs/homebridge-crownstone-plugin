import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { CrownstonePlatformConfig } from './config.js';
import { CrownstoneCloud } from 'crownstone-cloud';
import { CrownstoneSSE } from 'crownstone-sse';
import { CrownstoneUart } from 'crownstone-uart';
import { Crownstone } from './crownstone.js';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

// This is only required when using Custom Services and Characteristics not support by HomeKit
import { EveHomeKitTypes } from 'homebridge-lib/EveHomeKitTypes';

interface SSEOptions {
  sseUrl?:        string,
  loginUrl?:      string,
  hubLoginBase?:  string,
  autoreconnect?: boolean,
  requireAuthentication?: boolean,
  projectName?:   string,
}

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class CrownstonePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  public readonly crownstones: Map<string, Crownstone> = new Map();

  // This is only required when using Custom Services and Characteristics not support by HomeKit
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomServices: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomCharacteristics: any;

  public readonly cloud: CrownstoneCloud;
  public readonly uart: CrownstoneUart;
  public readonly sse: InstanceType<typeof CrownstoneSSE>;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig & CrownstonePlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // This is only required when using Custom Services and Characteristics not support by HomeKit
    this.CustomServices = new EveHomeKitTypes(this.api).Services;
    this.CustomCharacteristics = new EveHomeKitTypes(this.api).Characteristics;

    this.config.uartDevice =  this.config.uartDevice ?? '/dev/ttyUSB0';

    this.cloud = new CrownstoneCloud({
      customCloudAddress: this.config.v1CloudUrl,
      customCloudV2Address: this.config.v2CloudUrl,
    });
    this.sse = new CrownstoneSSE({
      sseUrl: this.config.sseCloudUrl,
      loginUrl: this.config.v1CloudUrl + 'users/login',
      hubLoginBase:  this.config.v1CloudUrl + '/Hubs',
      autoreconnect: true,
      requireAuthentication: true,
    } as SSEOptions);
    this.uart = new CrownstoneUart();

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      await this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  isSwitchStateUpdateEvent(data: SseEvent): data is SwitchStateUpdateEvent {
    return data.type === 'switchStateUpdate';
  }

  sseHandler(data: SseEvent) {
    if (!this.isSwitchStateUpdateEvent(data)) {
      return;
    }

    if (data.sphere.name !== this.config.sphereName) {
      return;
    }

    const crownstone = this.crownstones.get(data.crownstone.id);
    if (!crownstone) {
      return;
    }

    crownstone.handleUpdateOn(data.crownstone.percentage);
  }

  async discoverDevices() {
    await this.cloud.login(this.config.crownstoneUsername!, this.config.crownstonePassword!);
    await this.sse.login(this.config.crownstoneUsername!, this.config.crownstonePassword!);
    await this.sse.start(this.sseHandler.bind(this));

    await this.uart.start(this.config.uartDevice);

    const spheres = await this.cloud.spheres();
    const sphere = spheres.find(s => s.name === this.config.sphereName);
    if (!sphere) {
      this.log.error('Could not find sphere ', this.config.sphereName);
      this.log.debug('Spheres available ', spheres);
      return;
    }

    const crownstones = await this.cloud.rest.getCrownstonesInSphere(sphere.id);
    for (const crownstone of crownstones) {
      const uuid = this.api.hap.uuid.generate(crownstone.id);
      const existingAccessory = this.accessories.get(uuid);

      let crownstoneAccessory = undefined;

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        existingAccessory.context.device = crownstone;
        crownstoneAccessory = new Crownstone(this, existingAccessory, crownstone.id, crownstone.uid);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', crownstone.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(crownstone.name, uuid);
        accessory.context.device = crownstone;
        crownstoneAccessory = new Crownstone(this, accessory, crownstone.id, crownstone.uid);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      crownstoneAccessory.handleUpdateOn(crownstone.currentSwitchState.switchState);
      this.crownstones.set(crownstone.id, crownstoneAccessory);

      // push into discoveredCacheUUIDs
      this.discoveredCacheUUIDs.push(uuid);
    }

    // you can also deal with accessories from the cache which are no longer present by removing them from Homebridge
    // for example, if your plugin logs into a cloud account to retrieve a device list, and a user has previously removed a device
    // from this cloud account, then this device will no longer be present in the device list but will still be in the Homebridge cache
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
