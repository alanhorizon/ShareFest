(function () {
    sfclient = function () {
        this.pendingSwarms = [];
        this.clientId;
        this.initiateClient();
        this.registerEvents();
        this.chunkRead = 0;
        this.BW_INTERVAL = 500;
        this.lastDownCycleTime = Date.now();
        this.lastUpCycleTime;
        this.totalUpSinceLastCycle = 0
        this.lastCycleUpdateSizeInBytes = 0;
        this.firstTime = true;
        this.startTime;
        this.totalAvarageBw;
        this.lastReportTime = 0;
        this.lastStatCalcTime = 0;
        peer5.setLogLevel(2);

        //monitor the sendQueues
        this.cron_interval_id = window.setInterval(this.cron, peer5.config.MONITOR_INTERVAL, this);
    };

    sfclient.prototype = {
        updateMetadata:function (metadata) {
            if (!this.originator) {
                peer5.core.data.BlockCache.add(metadata.swarmId, new peer5.core.dataStructures.BlockMap(metadata.size));
            } else {
                peer5.core.data.BlockCache.alias(metadata.swarmId, metadata.name);
            }
            this.statsCalculator = new peer5.core.stats.StatsCalculator(metadata.size, metadata.name, '');
            var blockMap = peer5.core.data.BlockCache.get(metadata.swarmId);
            blockMap.addMetadata(metadata);
            this.controller = new peer5.core.controllers.P2PController(this.clientId, true);
            if(!this.originator){
                if (peer5.config.USE_FS) {
                    peer5.core.data.FSio.isExist(metadata.name,function(succ){
                        if(succ){
                            //file exists
                            console.log("Resource " + metadata.name + " exists already in the filesystem.");
                            blockMap.fs = true;
                            blockMap.initiateFromLocalData(0);
                        }else{
                            console.log("Resource " + metadata.name + " doesn't exist in the filesystem.");
                            peer5.core.data.FSio.createResource(metadata.name,function(succ){
                                if(succ){
                                    blockMap.fs = true;
                                }else{
                                    blockMap.fs = false;
                                }
                            });
                        }
                    })
                }
            }
            this.controller.init(metadata.swarmId, true);
        },

        addChunks:function (fileName, binarySlice,cb) {
            var blockMap = peer5.core.data.BlockCache.get(fileName);
            this.numOfChunksInSlice = Math.ceil(binarySlice.byteLength / peer5.config.CHUNK_SIZE);
            for (var i = 0; i < this.numOfChunksInSlice; i++) {
                var start = i * peer5.config.CHUNK_SIZE;
                var blockId = blockMap.setChunk(this.chunkRead, new Uint8Array(binarySlice.slice(start, Math.min(start + peer5.config.CHUNK_SIZE, binarySlice.byteLength))));
                blockMap.verifyBlock(blockId);
                this.chunkRead++;
            }
            if (this.chunkRead == this.numOfChunksInFile) {
                this.hasEntireFile = true;
            }
            if(peer5.config.USE_FS)
                peer5.core.data.FSio.notifyFinishWrite(cb);
        },

        cron:function (self) {
            self.sendReport();
            self.calculateStats();
        },

        calculateStats:function () {

            var currentTime = Date.now();

            if (currentTime - this.lastStatCalcTime < peer5.config.STAT_CALC_INTERVAL) return;
            this.lastStatCalcTime = currentTime;
            if (this.statsCalculator) {
                this.statsCalculator.calc_avg(false);
            }

        },

        prepareToReadFile:function (fileName, fileSize) {
            this.originator = true;
            peer5.core.data.BlockCache.add(fileName, new peer5.core.dataStructures.BlockMap(fileSize));
            var blockMap = peer5.core.data.BlockCache.get(fileName);
            blockMap.addMetadata({name:fileName});
            if (peer5.config.USE_FS){
                peer5.core.data.FSio.createResource(fileName,function(succ){
                    if(succ){
                        blockMap.fs = true;
                    }else{
                        blockMap.fs = false;
                    }
                });
            }
        },

        join:function (swarmId) {
            if (this.ws.socketReadyToSend()) {
                this.ws.sendMessage(new peer5.core.protocol.Join(swarmId));
            } else {
                this.pendingSwarms.push(swarmId);
            }
        },

        sendReport:function () {
            var thi$ = this;
            var currentTime = Date.now();
            if (currentTime - thi$.lastReportTime < peer5.config.REPORT_INTERVAL) return;
            thi$.lastReportTime = currentTime;
            peer5.core.data.BlockCache.forEach(function (blockMapId, blockMap) {
                if (blockMap.metadata && blockMap.metadata.swarmId) {
                    var reportMessage = new peer5.core.protocol.Report(
                        blockMap.metadata.swarmId, null,
                        null,
                        null,
                        null,
                        null,
                        null,
                        null, null,
                        null,
                        null, blockMap.availabilityMap.serialize(), blockMap.availabilityMap.numOfOnBits, blockMap.fileSize);
                    var encodedReportMessage = peer5.core.protocol.BinaryProtocol.encode([reportMessage]);
                    thi$.ws.sendData(encodedReportMessage);
                }
            });
        },

        isOrigin:function () {
            if (this.originator) {
                return this.originator
            } else {
                return false;
            }
        },


        saveFileLocally:function (blockMap) {
            var array = new Uint8Array(blockMap.fileSize);
            for (var i = 0; i < blockMap.getNumOfBlocks(); ++i) {
                array.set(blockMap.getBlock(i), i * peer5.config.BLOCK_SIZE);
            }
            var blob = new Blob([array]);
            saveLocally(blob, blockMap.getMetadata().name);
        },

        initiateClient:function () {
            var ws_url = location.protocol.replace('http','ws') +  '//';
            ws_url += location.host;

            this.clientId = peer5.core.util.generate_uuid();
            this.ws = new peer5.core.transport.WsConnection(ws_url, this.clientId);
        },

        receiveRequestMessage:function (requestMessage, originatorId) {
            peer5.log("received a request for " + requestMessage.chunkIds.length + " chunks");
            for (var i = 0; i < requestMessage.chunkIds.length; ++i) {
                this.sendData(originatorId, "swarmId", requestMessage.chunkIds[i]);
            }
        },

        upload:function (fileInfo) {
            var encodedMsg = peer5.core.protocol.BinaryProtocol.encode([fileInfo]);
            this.ws.sendData(encodedMsg);
        },

        registerEvents:function () {
            var thi$ = this;
            radio('transferFinishedEvent').subscribe([function (blockMap) {
                ga('send', 'event', 'transfer', 'downloadFinished', 'fileSize', blockMap.fileSize);
                if (!this.originator)
                    blockMap.saveLocally();
            }, this]);

            radio('swarmError').subscribe([function (errorObj) {
                switch (errorObj.error) {
                    case peer5.core.protocol.SWARM_NOT_FOUND:
                        radio('roomNotFound').broadcast();
                        peer5.log('empty room');
                        break;
                    case peer5.core.protocol.SWARM_ONLY_CHROME:
                        radio('roomOnlyChrome').broadcast();
                        break;
                    case peer5.core.protocol.SWARM_ONLY_FIREFOX:
                        radio('roomOnlyFirefox').broadcast();
                        break;
                }
            }, this]);

            //websockets events
            radio('receivedFileInfo').subscribe([function (fileInfo) {
                if (fileInfo.swarmId) {
                    if (peer5.core.data.BlockCache.get(fileInfo.swarmId) && peer5.core.data.BlockCache.get(fileInfo.swarmId).metadata)
                        peer5.log("I allready have metadata of swarm " + fileInfo.swarmId);
                    else {
                        this.updateMetadata(fileInfo);
                        radio('receivedNewFileInfo').broadcast(fileInfo);
                    }
                } else {
                    radio('roomNotFound').broadcast();
                    peer5.log('empty room');
                }
            }, this]);

            radio('socketConnected').subscribe([function () {
                this.clientId = this.ws.socket.socket.sessionid;
                console.log('got an id: ' + this.clientId);
            }, this]);

            radio('webSocketInit').subscribe([function () {
                for (var swarmId in this.pendingSwarms) {
                    this.ws.sendMessage(new peer5.core.protocol.Join(this.pendingSwarms[swarmId]));
                }
            }, this]);
        }
    };
})();
