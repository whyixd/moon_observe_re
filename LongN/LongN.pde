final int MOTOR_NUM = 5;
final int OUTTER_LED_NUM =76;//67;
final int INNER_LED_NUM = 0;
final int DIM=40;
final int STAR_DIM=20;
final boolean SHOW_SIMU = false;
final int UI_SIZE = 20;
final int MAX_DMX_SPEED = 230;
final int MID_DMX_SPEED = 60;
//final int SHOW_BEFORE_SHUTDOWN = 1;//28;

int LED_NUM=OUTTER_LED_NUM+INNER_LED_NUM;
transLight[] transLights=new transLight[MOTOR_NUM];
boolean isStopping = false;
boolean forceRunningMode = false;
boolean firstFrame = true;
int showCounter = 0;

boolean forceStoppingMode = false;
boolean performanceToogle = false;
boolean applyMoonCorection = true;
int outterCorectionNum = 15;
int innerCorectionNum = 7;

void settings()
{
  if(SHOW_SIMU)
    size(950, 750, P3D);
    //size(1920, 1080, P3D);
  else
    size(200, 345);
}

void setup() {
  surface.setLocation(10, 10);
  
  frameRate(40);
  
  //initUI();println("initUI ");
  //initVJ();
}

void draw()
{
  
  println(frameRate);
  if(isStopping)return;
  
  if(firstFrame)
  {
    //initClient();
    initArtnet();
    //readStarPosition();
    initSimulation();println("initSimulation ");
    initVideo();println("initVideo ");
    mv[0].loop();
    sendArtnet();
    firstFrame=false;
  }
    
  
  noStroke();
  //lights();
  if(SHOW_SIMU)
  {
    fill(0);
    sphere(5000);
  }
  else
    background(0);
   
 
  
  
  drawSimulation();
  drawVideo();

  getColor();
  getHeight();
  checkSamplePosition();
  //sendLedControlUdp();
  sendArtnet();
  //sendStarControlUdp();
  //sendMotorControlUdp();
  checkPerform();
  drawUI();
  //drawOutput();
  
  fill(255);
  text("Framerate:"+frameRate, width-110, height-10);
  if(!isStopping)text("Time:"+mv[playingMovieNum].time(), width-110, height-30);
  
}

void drawUI()
{
  for(int i=0;i<MOTOR_NUM;i++)
  {
    fill(200);
    text(i+1, width-UI_SIZE*3, (1+i)*UI_SIZE+2); 

    if(!transLights[i].isForceStop)
    {
      fill(100,220,100);
    }
    else
    {
      fill(220,100,100);
    }
    ellipse(width-UI_SIZE*2,i*UI_SIZE+18,15,15);
    
    
    if(transLights[i].isClockwise)
    {
      fill(100,220,100);
    }
    else
    {
      fill(220,100,100);
    }
    ellipse(width-UI_SIZE*1,i*UI_SIZE+18,10,10);
  }
}

void sendExit()
{
  sendArtnet();
  sendArtnet();
}

void exit()
{
  print("exit");
  isStopping=true;
  //serialExit();
  sendExit();
  movieExit();
  super.exit();
}
