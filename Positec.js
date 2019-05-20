const uuid = require('uuid')
const https = require('https')
const mqtt = require('mqtt')
const fs = require('fs')

const CFG = "Config.json"
const CMI = "cmdIn.json"
const CMO = "cmdOut.json"
const P12 = "AWS.p12"

function LandroidCloud() {
  var idx = -1

  this.dbgMode = process.argv.indexOf("-d") > -1
  idx = process.argv.indexOf("-l")
  if( idx > -1 ) {
    this.logFile = process.argv[idx+1]
    console.log("Log file: " + this.logFile)
  } else this.logFile = "landroid.csv"
  idx = process.argv.indexOf("-w")
  if( idx > -1 ) {
    this.webInfo = process.argv[idx+1]
    console.log("Web info: " + this.webInfo)
  }
}

/** Write debug string to console **/
LandroidCloud.prototype.debug = function (str) {
  if( this.dbgMode ) console.log(str)
}

/** API reguest */
LandroidCloud.prototype.api = function(method, path, json, cb) {
  var headers = {
    "Content-Type" : "application/json",
    "Authorization" : this.type + " " + this.token
  }
  if( json != null ) headers["Content-Length"] = Buffer.byteLength(json, 'utf8')
  var options = {
    host: this.webapi,
    path: "/api/v2/" + path,
    port: 443,
    method: method,
    headers: headers
  }

  var req = https.request(options, function(res) {
    var body = ""

    console.log("api " + method + ' ' + path + " -> ", res.statusCode)
    res.setEncoding('utf8')
    res.on('data', function(d) { body += d })
    res.on('end', function () { cb(JSON.parse(body)) })
  })
  if( json != null ) req.write(json)
  req.on('error', function(e) { console.error("api errror " + e) })
  req.end()
}

/** Start initialisation chain and ... */
LandroidCloud.prototype.start = function () {
  if( fs.existsSync(CFG) ) {
    var data = fs.readFileSync(CFG, "utf-8")
    var json = JSON.parse(data)

		this.uuid = json.uuid     // uuid.v4()
    this.email = json.email
    this.pass = json.pass
		this.webapi = json.webapi // api.worxlandroid.com
		this.secret = json.secret
		this.broker = json.broker // mqtts://commander-eu.worxlandroid.com
    this.topic = json.topic   // DB510/AABBCCDDEEFF

    console.log("WebApi: " + this.webapi)
    console.log("Secret: " + this.secret)
    console.log("Email:  " + this.email)
    console.log("Broker: " + this.broker)
    console.log("Topic:  " + this.topic)
    if( this.webInfo ) {
      this.retrieveUserToken() // login ...
    } else if( fs.existsSync(P12) ) { // fast connect
      this.p12 = fs.readFileSync(P12) //, "binary"
			console.log("Cert:   load from file")
      this.connectMqtt()
    } else {
      this.retrieveUserToken() // login ...
    }
  }
}

/** Login and retrieve user token */
LandroidCloud.prototype.retrieveUserToken = function () {
  var self = this

  var post = JSON.stringify({
    "username"    : this.email,
    "password"    : this.pass,
    "grant_type"  : "password",
    "client_id"   : 1,
    "client_secret" : this.secret,
    "scope"         : "*",
  })

  this.api('POST', "oauth/token", post, function(data) {
    self.token = data.access_token
    self.type = data.token_type
    self.debug("Token: " + self.type + " " + self.token)
    if( self.webInfo ) {
			self.retrieveWebInfo(self.webInfo)
		} else {
			self.retrieveAwsCert()
		}
  })
}

/** Retrieve AWS certificate */
LandroidCloud.prototype.retrieveAwsCert = function () {
  var self = this

  this.api('GET', "users/certificate", null, function(data) {
    self.p12 = Buffer.from(data.pkcs12, 'base64')
    console.log("AWS certificate done")
    fs.writeFileSync("AWS.p12", self.p12, 'binary')
    self.connectMqtt()
  })
}

/** Retrieve Info: boards, products, users/me, product-items[/SNR/(status|/weather/current)] */
LandroidCloud.prototype.retrieveWebInfo = function (info) {
  var self = this

  this.api('GET', info, null, function(data) {
    console.log("Data: " + JSON.stringify(data))
		if( self.webInfo == "users/me" ) console.log("Broker: " + data.mqtt_endpoint)
		if( self.webInfo == "product-items" ) {
			console.log("Serial: " + data[0].serial_number)
			console.log("Topic:  " + data[0].mqtt_topics.command_in.replace("/commandIn", ""))
		} 
  })
}

/** Connect Mqtt broker and ... */
LandroidCloud.prototype.connectMqtt = function () {
  var self = this

  var options = {
    pfx:      this.p12,
    clientId: "android-" + this.uuid
  }

  if( !fs.existsSync(this.logFile) ) this.prepareCsv()

	var client = mqtt.connect("mqtts://" + this.broker, options)
  var conn = -1

	this.debug("Connect: " + this.broker)
  client.on('connect', function() {
    conn++
    if( conn === 0  ) console.log("Mqtt connected :-)")
    else {
      console.log("Mqtt reconnected :-/ " + conn)
      if( conn >= 9  ) client.end()
    }
		self.debug("Subscribe: " + self.topic + "/commandOut")
    client.subscribe(self.topic + "/commandOut")
		self.debug("Publish:   " + self.topic + "/commandIn")
		client.publish(self.topic + "/commandIn", "{}")
		self.debug("Intervall: 10s")
		setInterval(() => {
			if( fs.existsSync(CMI) ) { // cfg to publish
				var cfg = fs.readFileSync(CMI)
				if( self.dbgMode ) console.log("Send: " + cfg)
				else process.stdout.write('^')
				client.publish(self.topic + "/commandIn", cfg)
				fs.unlinkSync(CMI)
			}
		}, 10000)
  })
  client.on('message', function(topic, message) {
    fs.writeFileSync(CMO, message)

    conn = 0
    self.receiveMqtt(JSON.parse(message))
    //console.log(message.toString())
  })
  client.on('error', function(err) {
    console.error(err.toString())
		client.end()
  })
  client.on('packetreceive', function(packet) { // subscribed or received
  })
}

LandroidCloud.prototype.prepareCsv = function() {
  var line = ""

  line += "datetime" + ';'
  line += "state" + ';' + "error" + ';'
  //line += "blade" + ';' + "distance" + ';' + "worktime" + ';'
  line += "temp" + ';' + "volt" + ';' + "perc" + ';' + "charge" + ';'
  //line += "pitch" + ';' + "roll" + ';' + "yaw" + ';'
  //line += "rssi"
  line += '\n'
  fs.writeFileSync(this.logFile, line)
}

function Comma(value) {
  return value.toString().replace('.', ',')
}
/** Receive Mqtt data */
LandroidCloud.prototype.receiveMqtt = function(x) {
  var line = ""

  if( this.dbgMode ) console.log("Recv: " + JSON.stringify(x))
	else process.stdout.write('.')
  line += x.cfg.tm + ' ' + x.cfg.dt.replace(/\//g, '.') + ';'
  line += x.dat.ls + ';' + x.dat.le + ';'
  //line += x.dat.st.b + ';' + x.dat.st.d + ';' + x.dat.st.wt + ';'
  line += Comma(x.dat.bt.t) + ';' + Comma(x.dat.bt.v) + ';' + x.dat.bt.p + ';' + x.dat.bt.c + ';'
  //line += Comma(x.dat.dmp[0]) + ';' + Comma(x.dat.dmp[1]) + ';' + Comma(x.dat.dmp[2]) + ';'
  //line += x.dat.rsi
  line += '\n'
  fs.appendFileSync(this.logFile, line)
}

var landroid = new LandroidCloud()
landroid.start()
