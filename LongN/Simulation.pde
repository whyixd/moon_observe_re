final int LOWEST_POS=200;
final int HIGHEST_POS=700;
final int STAGE_W = 1500;
final int STAGE_D = 800;
final int LED_SIZE=3;
final int LED_RADIUS = 35;
final int ARM_NUM=4;
final float SPIN_SPEED = 1.113;
final float Z_OFFSET =-160;
final int INIT_STAR_ARRAY_NUM = 200;
final int STAR_X_NUM = 19;
final int STAR_Y_NUM = 7;




float[][] starPos= new float[INIT_STAR_ARRAY_NUM][3]; 
//final int DOWN_DISTANCE_PER_ANGLE = 15;
//final int LIGHT_HIGHT = 60;
//final int LIGHT_RADIOUS = 11;
float halfW = STAGE_W/2;
float halfD = STAGE_D/2;
color[] starColor= new color[INIT_STAR_ARRAY_NUM];

void initSimulation()
{
  for(int i=0; i<MOTOR_NUM;i++ )
  {
    transLights[i] = new transLight();

  }
  if(!SHOW_SIMU) return;
  //readMotorPosition();
  calcMotorPosition();
}


void drawSimulation()
{
  if(!SHOW_SIMU) return;
  
  hint(ENABLE_DEPTH_TEST);
  
  pushMatrix();
  translate(width/2, height/2+40, 0); 
  scale(camScale);
  moveCamera();
  
  drawStage();
  //drawStar();
  fill(150);
  strokeWeight(LED_SIZE);
  
  for(int i=0;i<MOTOR_NUM;i++){
    
    for(int r=0;r<REPEAT_DRAW_NUM;r++)
    transLights[i].display();
  }
  
  popMatrix();
  hint(DISABLE_DEPTH_TEST);
  
}


void calcMotorPosition()
{
  float mid_pos = (LOWEST_POS+HIGHEST_POS)/2;
  float r= (HIGHEST_POS-LOWEST_POS)/2;
  float yr= (HIGHEST_POS-LOWEST_POS);
  for(int i=0;i<MOTOR_NUM;i++)
  {
    transLights[i].X=map(i,0,MOTOR_NUM-1,-LED_RADIUS*17,LED_RADIUS*17);
    transLights[i].Y=-map(sin((i+1)*(PI/(MOTOR_NUM+1))),-1,1,-yr,yr)+yr/3;
    transLights[i].Z=map(cos((i+1)*(PI/(MOTOR_NUM+1))+PI),-1,1,mid_pos-r,mid_pos+r)+Z_OFFSET;
    transLights[i].Angle=i*((PI*3/2)/(MOTOR_NUM-1))+PI/2;
    //println(transLights[i].X+","+transLights[i].Y+","+(transLights[i].Z+160));
  }
}

void drawStage()
{
  //noFill();
  fill(0,20,0);
  stroke(100);

  beginShape();
  vertex(-halfW,-halfD,Z_OFFSET);
  vertex(halfW,-halfD,Z_OFFSET);
  vertex(halfW,halfD,Z_OFFSET);
  vertex(-halfW,halfD,Z_OFFSET);
  vertex(-halfW,-halfD,Z_OFFSET);
  endShape(CLOSE);
  
  /*
  beginShape();
  vertex(-20,0,-160);
  vertex(20,-0,-160);
  vertex(20,0,10);
  vertex(-20,0,10);
  vertex(-20,0,0-160);
  endShape(CLOSE);  
  */

}
/*
void initStarPos()
{
  for(int x=0;x<=STAR_NUM_X;x++)
  {
    for(int y=0;y<=STAR_NUM_Y;y++)
    {
      starPos[x][y][0] = x*LED_RADIUS*2-halfW;
      starPos[x][y][1] = y*LED_RADIUS*2-halfD;
      starPos[x][y][2] = -140+sin(PI+float((2*y-x))/4)*30;
      
      float g_sum = 0;
      g_sum=
        cos(dist(starPos[x][y][0],starPos[x][y][1],transLights[0].X,transLights[0].Y)/150)*map(dist(starPos[x][y][0],starPos[x][y][1],transLights[0].X,transLights[0].Y),0,STAGE_W,60,0)+
        cos(dist(starPos[x][y][0],starPos[x][y][1],transLights[8].X,transLights[8].Y)/150)*map(dist(starPos[x][y][0],starPos[x][y][1],transLights[8].X,transLights[8].Y),0,STAGE_W,60,0);
      starPos[x][y][2]=g_sum*2/5-130;
        
      //vertex(x,y,-130);
      if(y%2==0)starPos[x][y][0]+=LED_RADIUS;
    }
  }
}
*/

void drawStar()
{
  
  strokeWeight(8);
  noFill();
  beginShape(POINTS);

  for(int x=0;x<totalStarNum;x++)
  {
    //stroke(255);
    stroke(starColor[x]);
    vertex(starPosition[x][0],starPosition[x][1],starPosition[x][2]);
  }
  
  endShape();
}
